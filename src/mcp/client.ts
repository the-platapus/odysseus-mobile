// MCP client session over any Transport: the counterpart of the Python SDK's ClientSession
// that Odysseus' McpManager drives.

import {
  CallToolResult,
  Implementation,
  InitializeResult,
  LATEST_PROTOCOL_VERSION,
  McpError,
  McpTool,
  SUPPORTED_PROTOCOL_VERSIONS,
  JSONRPC_INTERNAL_ERROR,
} from './protocol';
import type { Transport } from './transports';

export const CLIENT_INFO: Implementation = { name: 'odysseus-mobile', version: '1.0.0' };

const MAX_TOOL_PAGES = 20;

export class McpClient {
  readonly transport: Transport;
  serverInfo: Implementation | null = null;
  instructions = '';
  protocolVersion = '';
  private nextId = 1;

  constructor(transport: Transport) {
    this.transport = transport;
  }

  private async rpc(method: string, params?: Record<string, unknown>) {
    const response = await this.transport.request({ jsonrpc: '2.0', id: this.nextId++, method, params });
    if ('error' in response) throw new McpError(response.error.code, response.error.message, response.error.data);
    return response.result;
  }

  async connect(): Promise<InitializeResult> {
    const result = (await this.rpc('initialize', {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    })) as InitializeResult;
    if (!SUPPORTED_PROTOCOL_VERSIONS.includes(result.protocolVersion)) {
      throw new McpError(JSONRPC_INTERNAL_ERROR, `Unsupported MCP protocol version: ${result.protocolVersion}`);
    }
    this.protocolVersion = result.protocolVersion;
    this.serverInfo = result.serverInfo ?? null;
    this.instructions = typeof result.instructions === 'string' ? result.instructions : '';
    this.transport.setProtocolVersion(result.protocolVersion);
    await this.transport.notify({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return result;
  }

  async listTools(): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      const result = await this.rpc('tools/list', cursor ? { cursor } : undefined);
      tools.push(...((result?.tools ?? []) as McpTool[]));
      cursor = result?.nextCursor;
      if (!cursor) break;
    }
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    return (await this.rpc('tools/call', { name, arguments: args })) as CallToolResult;
  }

  async close() {
    await this.transport.close();
  }
}
