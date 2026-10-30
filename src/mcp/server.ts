// A minimal MCP server: answers initialize, ping, tools/list and tools/call.
//
// Built-in servers (files, memory) are written against this, the way Odysseus' mcp_servers/*.py
// are written against the Python SDK's `Server`. A phone can't spawn stdio subprocesses, so they
// run in-process behind InProcessTransport, but they still exchange real JSON-RPC MCP messages
// with McpClient. The same server could later be exposed over HTTP without changes.

import {
  CallToolResult,
  Implementation,
  JSONRPC_INTERNAL_ERROR,
  JSONRPC_INVALID_PARAMS,
  JSONRPC_INVALID_REQUEST,
  JSONRPC_METHOD_NOT_FOUND,
  JsonRpcMessage,
  JsonRpcResponse,
  JsonSchema,
  LATEST_PROTOCOL_VERSION,
  McpError,
  McpTool,
  SUPPORTED_PROTOCOL_VERSIONS,
  errorResult,
  isRequest,
} from './protocol';

export type ToolArgs = Record<string, unknown>;

export type ServerTool = McpTool & {
  handler: (args: ToolArgs) => Promise<CallToolResult> | CallToolResult;
};

export type McpServerDefinition = {
  info: Implementation;
  instructions?: string;
  tools: ServerTool[];
};

// Checks required keys and top-level primitive types only. Enough to give a small model a
// precise error to retry with; handlers still validate what they actually use.
export function validateArgs(schema: JsonSchema, args: ToolArgs): string | null {
  for (const key of schema.required ?? []) {
    if (args[key] === undefined || args[key] === null) return `Missing required argument "${key}".`;
  }
  for (const [key, value] of Object.entries(args)) {
    const prop = schema.properties?.[key];
    if (!prop || value === undefined || value === null) continue;
    const expected = Array.isArray(prop.type) ? prop.type : prop.type ? [prop.type] : [];
    if (expected.length === 0) continue;
    const actual = Array.isArray(value) ? 'array' : typeof value;
    const ok = expected.some((t) =>
      t === 'integer' ? Number.isInteger(value) : t === actual
    );
    if (!ok) return `Argument "${key}" must be ${expected.join(' or ')}, got ${actual}.`;
    if (prop.enum && !prop.enum.includes(value)) {
      return `Argument "${key}" must be one of: ${prop.enum.join(', ')}.`;
    }
  }
  return null;
}

export class McpServer {
  private def: McpServerDefinition;
  private toolsByName: Map<string, ServerTool>;

  constructor(def: McpServerDefinition) {
    this.def = def;
    this.toolsByName = new Map(def.tools.map((t) => [t.name, t]));
  }

  /** Handle one JSON-RPC message. Returns null for notifications. */
  async handle(message: JsonRpcMessage): Promise<JsonRpcResponse | null> {
    if (!isRequest(message)) return null;
    const { id, method, params = {} } = message;
    try {
      return { jsonrpc: '2.0', id, result: await this.dispatch(method, params) };
    } catch (e: any) {
      const code = e instanceof McpError ? e.code : JSONRPC_INTERNAL_ERROR;
      return { jsonrpc: '2.0', id, error: { code, message: e?.message ?? String(e) } };
    }
  }

  private async dispatch(method: string, params: Record<string, unknown>) {
    switch (method) {
      case 'initialize': {
        const requested = String(params.protocolVersion ?? '');
        return {
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: this.def.info,
          ...(this.def.instructions ? { instructions: this.def.instructions } : {}),
        };
      }
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: this.def.tools.map(({ handler, ...tool }) => tool) };
      case 'tools/call':
        return this.callTool(params);
      default:
        throw new McpError(JSONRPC_METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  private async callTool(params: Record<string, unknown>): Promise<CallToolResult> {
    const name = params.name;
    if (typeof name !== 'string') throw new McpError(JSONRPC_INVALID_REQUEST, 'tools/call needs a tool name');
    const tool = this.toolsByName.get(name);
    if (!tool) throw new McpError(JSONRPC_INVALID_PARAMS, `Unknown tool: ${name}`);
    const args = (params.arguments ?? {}) as ToolArgs;
    if (typeof args !== 'object' || Array.isArray(args)) return errorResult('Tool arguments must be a JSON object.');

    const invalid = validateArgs(tool.inputSchema, args);
    if (invalid) return errorResult(invalid);
    // Per the MCP spec, failures inside a tool are tool results (isError), not protocol errors,
    // so the model sees them and can correct itself.
    try {
      return await tool.handler(args);
    } catch (e: any) {
      return errorResult(`Error: ${e?.message ?? String(e)}`);
    }
  }
}
