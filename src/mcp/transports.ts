// Transports carry JSON-RPC messages between McpClient and a server.
//
// Odysseus supports stdio, SSE and Streamable HTTP. On a phone:
//   - stdio is replaced by InProcessTransport (built-in servers live in the JS runtime);
//   - Streamable HTTP is implemented here with fetch, for remote servers;
//   - the legacy SSE transport (deprecated in the MCP spec) is not implemented.

import {
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  McpError,
  JSONRPC_INTERNAL_ERROR,
  isResponse,
} from './protocol';
import type { McpServer } from './server';

export interface Transport {
  readonly kind: 'builtin' | 'http';
  request(message: JsonRpcRequest): Promise<JsonRpcResponse>;
  notify(message: JsonRpcNotification): Promise<void>;
  setProtocolVersion(version: string): void;
  close(): Promise<void>;
}

export class InProcessTransport implements Transport {
  readonly kind = 'builtin' as const;
  private server: McpServer;
  private closed = false;

  constructor(server: McpServer) {
    this.server = server;
  }

  async request(message: JsonRpcRequest): Promise<JsonRpcResponse> {
    if (this.closed) throw new McpError(JSONRPC_INTERNAL_ERROR, 'Transport closed');
    // Round-trip through JSON so built-ins can't share object references with callers,
    // exactly as if the message had crossed a process boundary.
    const response = await this.server.handle(JSON.parse(JSON.stringify(message)));
    if (!response) throw new McpError(JSONRPC_INTERNAL_ERROR, `No response to ${message.method}`);
    return JSON.parse(JSON.stringify(response));
  }

  async notify(message: JsonRpcNotification): Promise<void> {
    if (!this.closed) await this.server.handle(message);
  }

  setProtocolVersion() {}

  async close() {
    this.closed = true;
  }
}

export type HttpTransportOptions = {
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

const SESSION_HEADER = 'mcp-session-id';

/** Parse complete `data:` events out of an SSE buffer. Returns parsed events and the unconsumed rest. */
export function parseSseEvents(buffer: string): { events: string[]; rest: string } {
  const normalized = buffer.replace(/\r\n?/g, '\n');
  const blocks = normalized.split('\n\n');
  const rest = blocks.pop() ?? '';
  const events: string[] = [];
  for (const block of blocks) {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (data) events.push(data);
  }
  return { events, rest };
}

const findResponse = (payload: unknown, id: JsonRpcRequest['id']): JsonRpcResponse | null => {
  const items = Array.isArray(payload) ? payload : [payload];
  for (const item of items) {
    if (isResponse(item) && item.id === id) return item;
  }
  return null;
};

/**
 * MCP Streamable HTTP client transport (spec 2025-03-26+): every message is a POST to one
 * endpoint; the server answers with JSON or with an SSE stream that carries the response.
 * Server-initiated requests on that stream (sampling, elicitation) are ignored.
 */
export class StreamableHttpTransport implements Transport {
  readonly kind = 'http' as const;
  private url: string;
  private headers: Record<string, string>;
  private timeoutMs: number;
  private fetchImpl: typeof fetch;
  private sessionId: string | null = null;
  private protocolVersion: string | null = null;

  constructor(url: string, options: HttpTransportOptions = {}) {
    this.url = url;
    this.headers = options.headers ?? {};
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  setProtocolVersion(version: string) {
    this.protocolVersion = version;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...this.headers,
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    if (this.protocolVersion) headers['MCP-Protocol-Version'] = this.protocolVersion;
    return headers;
  }

  private async post(body: unknown, signal: AbortSignal) {
    const response = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
      signal,
    });
    const session = response.headers.get(SESSION_HEADER);
    if (session) this.sessionId = session;
    return response;
  }

  async request(message: JsonRpcRequest): Promise<JsonRpcResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.post(message, controller.signal);
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 200);
        if (response.status === 404 && this.sessionId) {
          this.sessionId = null;
          throw new McpError(JSONRPC_INTERNAL_ERROR, 'MCP session expired; reconnect the server.');
        }
        if (response.status === 401 || response.status === 403) {
          throw new McpError(JSONRPC_INTERNAL_ERROR, `Unauthorized (HTTP ${response.status}). Check the access token.`);
        }
        throw new McpError(JSONRPC_INTERNAL_ERROR, `HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
      }

      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('text/event-stream')) {
        const found = await this.readSse(response, message.id);
        controller.abort(); // stop reading a stream the server left open
        return found;
      }
      const found = findResponse(await response.json(), message.id);
      if (!found) throw new McpError(JSONRPC_INTERNAL_ERROR, `No response for ${message.method}`);
      return found;
    } catch (e: any) {
      if (e?.name === 'AbortError' || controller.signal.aborted) {
        throw new McpError(JSONRPC_INTERNAL_ERROR, `Timed out after ${Math.round(this.timeoutMs / 1000)}s (${message.method})`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  private async readSse(response: Response, id: JsonRpcRequest['id']): Promise<JsonRpcResponse> {
    const consume = (events: string[]) => {
      for (const data of events) {
        try {
          const found = findResponse(JSON.parse(data), id);
          if (found) return found;
        } catch {
          // ignore keep-alives and non-JSON events
        }
      }
      return null;
    };

    // Stream when the runtime supports it (expo/fetch, Node) so we can return as soon as the
    // response event arrives; otherwise fall back to reading the whole body.
    const reader = (response.body as any)?.getReader?.();
    if (!reader) {
      const found = consume(parseSseEvents((await response.text()) + '\n\n').events);
      if (!found) throw new McpError(JSONRPC_INTERNAL_ERROR, 'SSE stream ended without a response');
      return found;
    }

    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSseEvents(buffer);
      buffer = parsed.rest;
      const found = consume(parsed.events);
      if (found) {
        reader.cancel().catch(() => {});
        return found;
      }
    }
    const found = consume(parseSseEvents(buffer + '\n\n').events);
    if (!found) throw new McpError(JSONRPC_INTERNAL_ERROR, 'SSE stream ended without a response');
    return found;
  }

  async notify(message: JsonRpcNotification): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.post(message, controller.signal);
      // Servers answer notifications with 202 Accepted and no body.
      if (!response.ok) throw new McpError(JSONRPC_INTERNAL_ERROR, `HTTP ${response.status} for ${message.method}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async close() {
    if (!this.sessionId) return;
    // Best effort: tell the server it can drop the session.
    try {
      await this.fetchImpl(this.url, { method: 'DELETE', headers: this.buildHeaders() });
    } catch {
      // the server may already be gone
    }
    this.sessionId = null;
  }
}
