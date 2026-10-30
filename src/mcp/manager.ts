// McpManager: a port of Odysseus' src/mcp_manager.py.
//
// Owns live server connections, discovered tool schemas, qualified tool names
// (mcp__{server_id}__{tool_name}), OpenAI-format schema export for llama.rn, and call routing.
// Like the original it does not own policy: the agent loop decides which tools are offered
// and which calls need the user's approval.

import { McpClient } from './client';
import { CallToolResult, McpTool } from './protocol';
import type { Transport } from './transports';

export type ServerSpec = {
  id: string;
  name: string;
  builtin: boolean;
  /** Called on every (re)connect, so a reconnect gets a fresh transport and server state. */
  createTransport: () => Transport;
};

export type ServerStatus = 'connecting' | 'connected' | 'error' | 'timeout' | 'disconnected';

export type ServerState = {
  status: ServerStatus;
  name: string;
  transport: Transport['kind'];
  builtin: boolean;
  toolCount?: number;
  error?: string;
  serverName?: string;
  instructions?: string;
};

export type ToolResult = {
  output: string;
  isError: boolean;
  images?: { data: string; mimeType: string }[];
  truncated?: boolean;
};

export type DisabledMap = Record<string, string[] | undefined>;

export type OpenAITool = {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
};

export type ToolListing = {
  serverId: string;
  serverName: string;
  name: string;
  qualifiedName: string;
  description: string;
  readOnly: boolean;
  isDisabled: boolean;
};

const CONNECT_TIMEOUT_MS = 20000; // same per-server bound as Odysseus' startup connect
const CALL_TIMEOUT_MS = 60000;
// Odysseus lists central MCP output truncation as an open gap; a 4k-token phone context makes
// it mandatory here. Head and tail are kept so errors at the end of long output survive.
export const MAX_TOOL_OUTPUT_CHARS = 4000;

// --- Naming --------------------------------------------------------------------------------

const PREFIX = 'mcp';
const SEP = '__';

/**
 * Function names in tool schemas must match ^[a-zA-Z0-9_-]{1,64}$. With a server id of at
 * most 18 characters (see slugifyServerId), "mcp__" + id + "__" + 36 stays within 64.
 */
export const sanitizeToolName = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 36);

export const qualifiedName = (serverId: string, toolName: string) =>
  `${PREFIX}${SEP}${serverId}${SEP}${sanitizeToolName(toolName)}`;

export function parseQualifiedName(name: string): { serverId: string; toolName: string } | null {
  const parts = name.split(SEP);
  if (parts.length < 3 || parts[0] !== PREFIX || !parts[1]) return null;
  const toolName = parts.slice(2).join(SEP);
  return toolName ? { serverId: parts[1], toolName } : null;
}

/** Short label for the UI: mcp__files__read_file -> files.read_file */
export const displayToolName = (name: string) => {
  const parsed = parseQualifiedName(name);
  return parsed ? `${parsed.serverId}.${parsed.toolName}` : name;
};

/** Server ids become part of tool names, so keep them short, lowercase and free of "__". */
export function slugifyServerId(name: string, taken: Iterable<string>): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 16).replace(/^_+|_+$/g, '') || 'server';
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base}${i}`)) return `${base}${i}`;
}

// --- Read-only classification (port of mcp_tool_is_readonly) -------------------------------

// PREFIXES, not whole words: "summar" covers summarise/summarize/summary.
const READONLY_VERBS = [
  'list', 'get', 'read', 'search', 'fetch', 'query', 'find', 'describe',
  'show', 'view', 'lookup', 'count', 'status', 'info', 'inspect', 'summar',
];

/**
 * Prefer the server's annotations; otherwise use a tool-name verb heuristic and FAIL CLOSED
 * (treat as a write) for anything that doesn't clearly read.
 */
export function mcpToolIsReadonly(tool: McpTool): boolean {
  const ann = tool.annotations;
  if (ann?.readOnlyHint === true) return true;
  if (ann?.readOnlyHint === false || ann?.destructiveHint === true) return false;
  const name = (tool.name || '').toLowerCase();
  return READONLY_VERBS.some((verb) => name.startsWith(verb));
}

/**
 * Per-call refinement for multiplexed tools like `manage_memory`, whose `action` argument picks
 * a read or a write. Only un-annotated tools are refined, and only to read-only when the action
 * itself is a read verb; anything else stays a write.
 */
export function mcpCallIsReadonly(tool: McpTool, args: Record<string, unknown>): boolean {
  if (mcpToolIsReadonly(tool)) return true;
  const ann = tool.annotations;
  if (ann?.readOnlyHint !== undefined || ann?.destructiveHint !== undefined) return false;
  const action = typeof args.action === 'string' ? args.action.toLowerCase() : '';
  return !!action && READONLY_VERBS.some((verb) => action.startsWith(verb));
}

// --- Result formatting (port of McpManager._do_call) ---------------------------------------

export function truncateMiddle(text: string, max = MAX_TOOL_OUTPUT_CHARS): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const head = Math.floor(max * 0.7);
  const tail = max - head;
  const dropped = text.length - head - tail;
  return {
    text: `${text.slice(0, head)}\n…[${dropped} characters truncated]…\n${text.slice(text.length - tail)}`,
    truncated: true,
  };
}

export function formatCallResult(result: CallToolResult): ToolResult {
  const parts: string[] = [];
  const images: { data: string; mimeType: string }[] = [];
  for (const item of result?.content ?? []) {
    if (item.type === 'text') parts.push(item.text);
    else if (item.type === 'image') {
      images.push({ data: item.data, mimeType: item.mimeType });
      parts.push(`[Image (${item.mimeType})]`);
    } else if (item.type === 'audio') parts.push(`[Audio (${item.mimeType})]`);
    else if (item.type === 'resource_link') parts.push(`[Resource: ${item.name ?? item.uri}]`);
    else if (item.type === 'resource') parts.push(item.resource.text ?? `[Resource: ${item.resource.uri}]`);
  }
  if (parts.length === 0 && result?.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent));
  }
  const { text, truncated } = truncateMiddle(parts.join('\n'));
  return {
    output: text,
    isError: result?.isError === true,
    ...(images.length ? { images } : {}),
    ...(truncated ? { truncated } : {}),
  };
}

const withTimeout = <T>(promise: Promise<T>, ms: number, message: string): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });

// --- Manager -------------------------------------------------------------------------------

export class McpManager {
  private specs = new Map<string, ServerSpec>();
  private connections = new Map<string, ServerState>();
  private clients = new Map<string, McpClient>();
  private tools = new Map<string, McpTool[]>();
  private listeners = new Set<() => void>();
  // Bumped whenever servers or tools change, like Odysseus' prompt-cache generation.
  generation = 0;

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed() {
    this.generation++;
    for (const listener of this.listeners) listener();
  }

  private setState(id: string, state: ServerState) {
    this.connections.set(id, state);
    this.changed();
  }

  async connectServer(spec: ServerSpec, timeoutMs = CONNECT_TIMEOUT_MS): Promise<boolean> {
    await this.disconnectServer(spec.id, { keepSpec: true, silent: true });
    this.specs.set(spec.id, spec);
    const base = { name: spec.name, builtin: spec.builtin };
    let transport: Transport;
    try {
      transport = spec.createTransport();
    } catch (e: any) {
      this.setState(spec.id, { ...base, transport: 'http', status: 'error', error: e?.message ?? String(e) });
      return false;
    }
    this.setState(spec.id, { ...base, transport: transport.kind, status: 'connecting' });

    const client = new McpClient(transport);
    try {
      // Session, tools and status are registered as one unit, only after discovery succeeds.
      const tools = await withTimeout(
        client.connect().then(() => client.listTools()),
        timeoutMs,
        `Timed out after ${Math.round(timeoutMs / 1000)} seconds`
      );
      if (this.specs.get(spec.id) !== spec) {
        // Removed or replaced while connecting.
        await client.close().catch(() => {});
        return false;
      }
      this.clients.set(spec.id, client);
      this.tools.set(spec.id, tools);
      this.setState(spec.id, {
        ...base,
        transport: transport.kind,
        status: 'connected',
        toolCount: tools.length,
        serverName: client.serverInfo?.name,
        instructions: client.instructions,
      });
      return true;
    } catch (e: any) {
      // Close the partial connection so it can't leak into later reconnects.
      await client.close().catch(() => {});
      if (this.specs.get(spec.id) !== spec) return false;
      const message = e?.message ?? String(e);
      this.setState(spec.id, {
        ...base,
        transport: transport.kind,
        status: message.startsWith('Timed out') ? 'timeout' : 'error',
        error: message,
      });
      return false;
    }
  }

  async reconnect(id: string): Promise<boolean> {
    const spec = this.specs.get(id);
    return spec ? this.connectServer(spec) : false;
  }

  async disconnectServer(id: string, opts: { keepSpec?: boolean; silent?: boolean } = {}) {
    const client = this.clients.get(id);
    this.clients.delete(id);
    this.tools.delete(id);
    if (!opts.keepSpec) this.specs.delete(id);
    const hadState = this.connections.delete(id);
    if (client) await client.close().catch(() => {});
    if (!opts.silent && (client || hadState)) this.changed();
  }

  async disconnectAll() {
    await Promise.all([...this.specs.keys()].map((id) => this.disconnectServer(id)));
  }

  isBuiltin(id: string) {
    return this.specs.get(id)?.builtin ?? false;
  }

  getServerState(id: string): ServerState {
    return this.connections.get(id) ?? { status: 'disconnected', name: id, transport: 'http', builtin: false };
  }

  getAllStates(): Record<string, ServerState> {
    return Object.fromEntries(this.connections);
  }

  getServerTools(id: string): McpTool[] {
    return this.tools.get(id) ?? [];
  }

  /** Resolve a qualified name to its server and original (unsanitized) tool. */
  resolveTool(name: string): { serverId: string; tool: McpTool } | null {
    const parsed = parseQualifiedName(name);
    if (!parsed) return null;
    const tool = this.tools.get(parsed.serverId)?.find((t) => sanitizeToolName(t.name) === parsed.toolName);
    return tool ? { serverId: parsed.serverId, tool } : null;
  }

  isToolDisabled(name: string, disabled: DisabledMap = {}): boolean {
    const resolved = this.resolveTool(name);
    return !!resolved && (disabled[resolved.serverId] ?? []).includes(resolved.tool.name);
  }

  getAllTools(disabled: DisabledMap = {}): ToolListing[] {
    const out: ToolListing[] = [];
    for (const [serverId, tools] of this.tools) {
      const off = disabled[serverId] ?? [];
      const serverName = this.connections.get(serverId)?.name ?? serverId;
      for (const tool of tools) {
        out.push({
          serverId,
          serverName,
          name: tool.name,
          qualifiedName: qualifiedName(serverId, tool.name),
          description: tool.description ?? '',
          readOnly: mcpToolIsReadonly(tool),
          isDisabled: off.includes(tool.name),
        });
      }
    }
    return out;
  }

  /** Enabled tools in OpenAI function-calling format, for llama.rn's `tools` parameter. */
  getOpenAITools(disabled: DisabledMap = {}): OpenAITool[] {
    const schemas: OpenAITool[] = [];
    for (const [serverId, tools] of this.tools) {
      const off = disabled[serverId] ?? [];
      // Built-in descriptions are written for this app; remote ones get a server label so the
      // model can tell same-named tools apart, as Odysseus does with "[MCP:label]".
      const label = this.isBuiltin(serverId) ? '' : `[MCP:${this.connections.get(serverId)?.name ?? serverId}] `;
      for (const tool of tools) {
        if (off.includes(tool.name)) continue;
        schemas.push({
          type: 'function',
          function: {
            name: qualifiedName(serverId, tool.name),
            description: `${label}${tool.description ?? ''}`.trim(),
            parameters: (tool.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
          },
        });
      }
    }
    return schemas;
  }

  /** Call a tool by qualified name. Never throws: failures come back as isError results. */
  async callTool(name: string, args: Record<string, unknown>, timeoutMs = CALL_TIMEOUT_MS): Promise<ToolResult> {
    const resolved = this.resolveTool(name);
    if (!resolved) return { output: `Unknown MCP tool: ${name}`, isError: true };
    const { serverId, tool } = resolved;

    const attempt = async () => {
      const client = this.clients.get(serverId);
      if (!client) throw new Error(`MCP server not connected: ${serverId}`);
      return formatCallResult(
        await withTimeout(client.callTool(tool.name, args), timeoutMs, `${tool.name} timed out after ${Math.round(timeoutMs / 1000)}s`)
      );
    };

    try {
      return await attempt();
    } catch (e: any) {
      // Built-ins get one reconnect-and-retry, as in Odysseus. Remote servers return the
      // failure: retrying a non-idempotent remote call could apply it twice.
      if (this.isBuiltin(serverId) && (await this.reconnect(serverId))) {
        try {
          return await attempt();
        } catch (e2: any) {
          return { output: `Error: ${e2?.message ?? String(e2)}`, isError: true };
        }
      }
      return { output: `Error: ${e?.message ?? String(e)}`, isError: true };
    }
  }
}
