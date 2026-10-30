// MCP wire types (JSON-RPC 2.0) and the small set of MCP shapes this app speaks.
// Mirrors the subset Odysseus uses through the Python `mcp` SDK: initialize,
// tools/list and tools/call. Resources, prompts and sampling are not implemented.

export const LATEST_PROTOCOL_VERSION = '2025-06-18';
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_INTERNAL_ERROR = -32603;

export type JsonRpcId = string | number;

export type JsonRpcRequest = {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
};

export type JsonRpcNotification = {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
};

export type JsonRpcError = { code: number; message: string; data?: unknown };

export type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: JsonRpcId; result: any }
  | { jsonrpc: '2.0'; id: JsonRpcId | null; error: JsonRpcError };

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export type JsonSchema = {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: unknown[];
  items?: JsonSchema;
  [key: string]: unknown;
};

export type ToolAnnotations = {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

export type McpTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: JsonSchema;
  annotations?: ToolAnnotations;
};

export type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'audio'; data: string; mimeType: string }
  | { type: 'resource_link'; uri: string; name?: string }
  | { type: 'resource'; resource: { uri: string; mimeType?: string; text?: string; blob?: string } };

export type CallToolResult = {
  content: McpContent[];
  structuredContent?: unknown;
  isError?: boolean;
};

export type Implementation = { name: string; version: string; title?: string };

export type InitializeResult = {
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  serverInfo: Implementation;
  instructions?: string;
};

export class McpError extends Error {
  code: number;
  data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    this.data = data;
  }
}

export const isResponse = (msg: unknown): msg is JsonRpcResponse =>
  !!msg && typeof msg === 'object' && 'id' in msg && ('result' in msg || 'error' in msg);

export const isRequest = (msg: unknown): msg is JsonRpcRequest =>
  !!msg && typeof msg === 'object' && 'method' in msg && 'id' in msg;

export const textContent = (text: string): McpContent => ({ type: 'text', text });

export const textResult = (text: string): CallToolResult => ({ content: [textContent(text)] });

export const errorResult = (text: string): CallToolResult => ({ content: [textContent(text)], isError: true });
