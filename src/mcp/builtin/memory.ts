// Built-in "memory" MCP server: a port of Odysseus' mcp_servers/memory_server.py.
// Same single `manage_memory` tool and actions, stored on the device. Search is keyword
// overlap for now; llama.rn's embedding() could back a vector search later, as Odysseus'
// MemoryVectorStore does.

import { McpServer, ToolArgs } from '../server';
import { errorResult, textResult } from '../protocol';

export const MEMORY_CATEGORIES = ['fact', 'event', 'contact', 'preference'] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export type MemoryEntry = {
  id: string;
  text: string;
  category: MemoryCategory;
  source: string;
  timestamp: number;
};

export interface MemoryStore {
  load(): Promise<MemoryEntry[]>;
  save(entries: MemoryEntry[]): Promise<void>;
}

const newId = () => Date.now().toString(16) + Math.random().toString(16).slice(2, 10);
const shortId = (id: string) => id.slice(0, 8);
const clip = (text: string, max: number) => (text.length > max ? text.slice(0, max - 3) + '...' : text);

const tokenize = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** Score memories by the share of query words they contain. */
export function searchMemories(entries: MemoryEntry[], query: string, maxItems = 20): MemoryEntry[] {
  const words = [...new Set(tokenize(query))];
  if (words.length === 0) return [];
  return entries
    .map((entry) => {
      const have = new Set(tokenize(entry.text));
      return { entry, score: words.filter((w) => have.has(w)).length / words.length };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || b.entry.timestamp - a.entry.timestamp)
    .slice(0, maxItems)
    .map((r) => r.entry);
}

const findByPrefix = (entries: MemoryEntry[], id: string) => entries.find((m) => m.id.startsWith(id));

export function createMemoryServer(store: MemoryStore): McpServer {
  const handler = async (args: ToolArgs) => {
    const action = String(args.action ?? '');
    const text = typeof args.text === 'string' ? args.text.trim() : '';
    const memoryId = typeof args.memory_id === 'string' ? args.memory_id.trim() : '';
    const category = (args.category as MemoryCategory | undefined) ?? undefined;
    const memories = await store.load();

    switch (action) {
      case 'list': {
        const shown = category ? memories.filter((m) => m.category === category) : memories;
        if (shown.length === 0) return textResult(`No memories found${category ? ` in category '${category}'` : ''}.`);
        const lines = shown.map((m) => `- [${m.category}] \`${shortId(m.id)}\` — ${clip(m.text, 150)}`);
        return textResult(`Found ${shown.length} memory entries:\n${lines.join('\n')}`);
      }
      case 'add': {
        if (!text) return errorResult('Error: Memory text cannot be empty');
        const entry: MemoryEntry = { id: newId(), text, category: category ?? 'fact', source: 'ai_agent', timestamp: Date.now() };
        await store.save([...memories, entry]);
        return textResult(`Memory added: [${entry.category}] ${text} (id: ${shortId(entry.id)})`);
      }
      case 'edit': {
        if (!memoryId || !text) return errorResult('Error: edit needs memory_id and text');
        const target = findByPrefix(memories, memoryId);
        if (!target) return errorResult(`Error: Memory '${memoryId}' not found`);
        await store.save(memories.map((m) => (m.id === target.id ? { ...m, text, timestamp: Date.now() } : m)));
        return textResult(`Memory updated: ${text}`);
      }
      case 'delete': {
        if (!memoryId) return errorResult('Error: delete needs memory_id');
        const target = findByPrefix(memories, memoryId);
        if (!target) return errorResult(`Error: Memory '${memoryId}' not found`);
        await store.save(memories.filter((m) => m.id !== target.id));
        return textResult(`Memory deleted: [${target.category}] ${clip(target.text, 120)} (id: ${memoryId})`);
      }
      case 'search': {
        if (!text) return errorResult('Error: search needs text (query)');
        const results = searchMemories(memories, text);
        if (results.length === 0) return textResult(`No memories found matching '${text}'.`);
        const lines = results.map((m) => `- [${m.category}] \`${shortId(m.id)}\` — ${m.text}`);
        return textResult(`Found ${results.length} matching memories:\n${lines.join('\n')}`);
      }
      default:
        return errorResult(`Error: Unknown action '${action}'. Use: list, add, edit, delete, search`);
    }
  };

  return new McpServer({
    info: { name: 'odysseus-mobile-memory', version: '1.0.0' },
    instructions: 'Save lasting facts and preferences the user shares with manage_memory, and search it before asking the user something they may have told you.',
    tools: [
      {
        name: 'manage_memory',
        description: "Manage the user's memory system: list, add, edit, delete, or search memories.",
        // No annotations, as in Odysseus: list/search are classified read-only per call
        // (see mcpCallIsReadonly), add/edit/delete ask for approval.
        inputSchema: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'add', 'edit', 'delete', 'search'], description: 'The action to perform' },
            text: { type: 'string', description: 'Memory text (add/edit) or search query (search)' },
            memory_id: { type: 'string', description: 'Memory ID (edit/delete)' },
            category: { type: 'string', enum: [...MEMORY_CATEGORIES], description: 'Memory category (add/list filter)' },
          },
          required: ['action'],
        },
        handler,
      },
    ],
  });
}
