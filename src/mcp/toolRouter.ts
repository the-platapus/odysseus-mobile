// Chooses which tools the model sees for a message, so more tools can be connected than a 4k
// context can hold. The idea is Odysseus' src/tool_index.py; word matching (BM25) stands in for
// its embeddings, because a phone would have to load a second model to embed a query.
//
// While every enabled tool fits the budget they are all offered and nothing here applies. Past
// that, the budget goes first to the tools used in the last two turns (so "now delete it" keeps
// working), then to the tools that match the message's words, then to the built-ins. The
// built-ins come last rather than being left out because the router only knows about words: a
// message it didn't understand, or one in another language, should still get them.
//
// Tools sit at the start of the prompt, so any change to the offered set makes llama.rn process
// the whole prompt again. Pick once per user message, and keep the manager's order.

import type { ChatMessage } from './agentLoop';
import type { DisabledMap, McpManager, OpenAITool } from './manager';

// What's left of a 4096-token context for tool schemas after the system prompt, about 1,300
// tokens of history (AGENT_HISTORY_CHARS), a 900-token tool result and the reply.
export const TOOL_TOKEN_BUDGET = 1000;
// Measured with Qwen3's tokenizer on the built-in tools: 3.49 characters of schema JSON per
// token, plus 77 tokens the chat template wraps around them.
const CHARS_PER_TOKEN = 3.5;
const TEMPLATE_TOKENS = 80;

const RECENT_TURNS = 2;
// Enough to know what a tool does; long descriptions are mostly usage notes and examples.
const DESCRIPTION_CHARS = 400;

const STOP_WORDS = new Set(
  'a an the to of in on at for my me i is are do does did what whats how much many this that it and or with by from be you your can please just right now mcp'.split(' ')
);

export type ToolHints = { builtin: boolean; keywords?: string };

const tokensOf = (tool: OpenAITool) => JSON.stringify(tool).length / CHARS_PER_TOKEN;

/** Estimated prompt tokens for offering `tools`. */
export const toolTokens = (tools: OpenAITool[]) => tools.reduce((n, tool) => n + tokensOf(tool), TEMPLATE_TOKENS);

/** Rough plural and -ing removal, so "files" finds "file" and "making" finds "make". */
function stem(word: string): string {
  if (word.endsWith('ss')) return word;
  const root = word.replace(/(?:ing|es|s)$/, '');
  const base = root.length >= 3 ? root : word;
  return base.length > 3 && base.endsWith('e') ? base.slice(0, -1) : base;
}

function words(text: string): string[] {
  const found = text.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return found.filter((word) => word.length > 1 && !STOP_WORDS.has(word)).map(stem);
}

/**
 * Names of tools that share a word with `query`, best first. There's deliberately no minimum
 * score: a word in most of the tools counts for little, so a floor drops a 20-tool weather
 * server from "what's the weather", and on real servers it didn't filter out chit-chat anyway.
 */
function matchTools(tools: OpenAITool[], query: string, hintsOf: (name: string) => ToolHints): string[] {
  const terms = new Set(words(query));
  if (terms.size === 0) return [];

  const docs = tools.map(({ function: fn }) => {
    const heavy = [...words(fn.name), ...words(hintsOf(fn.name).keywords ?? '')];
    return [...heavy, ...heavy, ...heavy, ...words(fn.description.slice(0, DESCRIPTION_CHARS))];
  });
  const counts = docs.map((doc) => {
    const count = new Map<string, number>();
    for (const word of doc) count.set(word, (count.get(word) ?? 0) + 1);
    return count;
  });
  const averageLength = docs.reduce((n, doc) => n + doc.length, 0) / docs.length;
  const idf = (term: string) => {
    const having = counts.filter((count) => count.has(term)).length;
    return Math.log(1 + (docs.length - having + 0.5) / (having + 0.5));
  };

  const weights = [...terms].map((term) => ({ term, weight: idf(term) }));
  return tools
    .map(({ function: fn }, i) => {
      const lengthRatio = docs[i].length / averageLength;
      const score = weights.reduce((sum, { term, weight }) => {
        const tf = counts[i].get(term) ?? 0;
        return sum + (weight * tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * lengthRatio));
      }, 0);
      return { name: fn.name, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ name }) => name);
}

/** Tools called in the turns before the latest user message, newest first. */
function recentToolNames(messages: ChatMessage[]): string[] {
  const names: string[] = [];
  let userMessages = 0;
  for (let i = messages.length - 1; i >= 0 && userMessages <= RECENT_TURNS; i--) {
    const message = messages[i];
    if (message.role === 'user') userMessages++;
    if (message.role === 'assistant') names.push(...(message.tool_calls ?? []).map((call) => call.function.name));
  }
  return names;
}

const latestUserText = (messages: ChatMessage[]) => [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';

/** The tools to offer for `messages`, which end with the user's new message. */
export function pickTools(
  tools: OpenAITool[],
  messages: ChatMessage[],
  hintsOf: (name: string) => ToolHints,
  budget = TOOL_TOKEN_BUDGET
): OpenAITool[] {
  if (toolTokens(tools) <= budget) return tools;

  const matches = matchTools(tools, latestUserText(messages), hintsOf);
  const builtins = tools.map((tool) => tool.function.name).filter((name) => hintsOf(name).builtin);

  const byName = new Map(tools.map((tool) => [tool.function.name, tool]));
  const chosen = new Set<string>();
  let used = TEMPLATE_TOKENS;
  for (const name of [...recentToolNames(messages), ...matches, ...builtins]) {
    const tool = byName.get(name);
    // A tool too big for what's left is skipped, not the end: a smaller one may still fit.
    if (!tool || chosen.has(name) || used + tokensOf(tool) > budget) continue;
    chosen.add(name);
    used += tokensOf(tool);
  }
  return tools.filter((tool) => chosen.has(tool.function.name));
}

export const routeTools = (manager: McpManager, messages: ChatMessage[], disabled: DisabledMap = {}) =>
  pickTools(manager.getOpenAITools(disabled), messages, (name) => manager.getToolHints(name));
