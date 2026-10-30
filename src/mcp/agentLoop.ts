// The agent loop: a phone-sized port of the core of Odysseus' src/agent_loop.py.
//
// One user turn = up to `maxRounds` model rounds. Each round the model may answer or emit
// native tool calls (parsed by llama.cpp from the model's own chat template). Calls are
// checked against policy, executed through McpManager and fed back as `tool` messages.
// Kept from Odysseus: fail-closed approval for non-read-only tools, execution-time enforcement
// of disabled tools, suppression of repeated identical calls, and a final no-tools round when
// the budget runs out so the user always gets an answer.

import {
  DisabledMap,
  McpManager,
  OpenAITool,
  ToolResult,
  mcpCallIsReadonly,
} from './manager';
import type { McpTool } from './protocol';

export type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };

export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: ToolCall[] }
  | { role: 'tool'; content: string; tool_call_id: string; name: string };

export type CompletionRequest = {
  messages: ChatMessage[];
  tools?: OpenAITool[];
  /** Receives the parsed assistant content accumulated so far in this round. */
  onContent: (text: string) => void;
  /** Receives the model's thinking accumulated so far, for models that think. */
  onReasoning?: (text: string) => void;
};

export type CompletionResponse = {
  content: string;
  reasoning?: string;
  toolCalls: { id?: string | null; function: { name: string; arguments: string } }[];
  interrupted: boolean;
};

export type CompleteFn = (request: CompletionRequest) => Promise<CompletionResponse>;

export type PendingCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
  rawArgs: string;
  readOnly: boolean;
};

export type AgentEvent =
  | { type: 'round_start'; round: number }
  | { type: 'content'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'assistant'; content: string; reasoning: string; toolCalls: ToolCall[] }
  | { type: 'tool_call'; call: PendingCall; needsApproval: boolean }
  | { type: 'tool_running'; id: string }
  | { type: 'tool_result'; id: string; result: ToolResult; denied?: boolean }
  | { type: 'done'; reason: DoneReason };

export type DoneReason = 'final' | 'max_rounds' | 'stopped';

export type RunAgentOptions = {
  complete: CompleteFn;
  manager: McpManager;
  messages: ChatMessage[];
  disabled?: DisabledMap;
  maxRounds?: number;
  /** false = a plain templated chat turn: one round, no tools offered. Default true. */
  offerTools?: boolean;
  /** Ask the user. Resolve true to run the call. Without it, calls needing approval are denied. */
  requestApproval?: (call: PendingCall) => Promise<boolean>;
  /** Calls that skip approval even though they write (e.g. "allow for this chat"). */
  isPreApproved?: (call: PendingCall) => boolean;
  onEvent: (event: AgentEvent) => void;
  isStopped?: () => boolean;
};

export const DEFAULT_MAX_ROUNDS = 5;

// 9 alphanumerics: valid for every template llama.cpp knows, including Mistral's strict ids.
const newCallId = () => {
  let id = '';
  while (id.length < 9) id += Math.random().toString(36).slice(2);
  return id.slice(0, 9);
};

const parseArgs = (raw: string): Record<string, unknown> | string => {
  if (!raw || !raw.trim()) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : 'Tool arguments must be a JSON object.';
  } catch (e: any) {
    return `Tool arguments are not valid JSON (${e?.message ?? 'parse error'}).`;
  }
};

const callSignature = (name: string, args: Record<string, unknown>) => `${name}:${JSON.stringify(args)}`;

export async function runAgentTurn(options: RunAgentOptions): Promise<{ messages: ChatMessage[]; reason: DoneReason }> {
  const { complete, manager, disabled = {}, onEvent, requestApproval, isPreApproved } = options;
  const offerTools = options.offerTools ?? true;
  const maxRounds = offerTools ? options.maxRounds ?? DEFAULT_MAX_ROUNDS : 0;
  const isStopped = options.isStopped ?? (() => false);
  const history: ChatMessage[] = [...options.messages];
  const added: ChatMessage[] = [];
  const push = (message: ChatMessage) => {
    history.push(message);
    added.push(message);
  };
  const finish = (reason: DoneReason) => {
    onEvent({ type: 'done', reason });
    return { messages: added, reason };
  };

  const succeeded = new Set<string>();

  // Returns the result and whether the call merely repeated an earlier successful one.
  const executeCall = async (tc: ToolCall): Promise<{ result: ToolResult; repeat: boolean }> => {
    const name = tc.function.name;
    const parsed = parseArgs(tc.function.arguments);
    const tool: McpTool | undefined = manager.resolveTool(name)?.tool;
    const call: PendingCall = {
      id: tc.id,
      name,
      args: typeof parsed === 'string' ? {} : parsed,
      rawArgs: tc.function.arguments,
      readOnly: tool && typeof parsed !== 'string' ? mcpCallIsReadonly(tool, parsed) : false,
    };
    const settle = (result: ToolResult, repeat = false, denied = false) => {
      onEvent({ type: 'tool_result', id: tc.id, result, ...(denied ? { denied } : {}) });
      return { result, repeat };
    };
    const fail = (output: string) => {
      onEvent({ type: 'tool_call', call, needsApproval: false });
      return settle({ output, isError: true });
    };

    if (typeof parsed === 'string') return fail(`Error: ${parsed}`);
    if (!tool) return fail(`Error: Unknown tool "${name}". Use only the tools you were given.`);
    // Disabled tools are hidden from the schema list, but a model can still emit the name.
    if (manager.isToolDisabled(name, disabled)) return fail(`Error: Tool "${name}" is disabled by the user.`);

    const signature = callSignature(name, call.args);
    if (succeeded.has(signature)) {
      onEvent({ type: 'tool_call', call, needsApproval: false });
      return settle({ output: 'Already called with these exact arguments; use the earlier result.', isError: false }, true);
    }

    const needsApproval = !call.readOnly && !(isPreApproved?.(call) ?? false);
    onEvent({ type: 'tool_call', call, needsApproval });
    if (needsApproval && !(requestApproval ? await requestApproval(call) : false)) {
      return settle({ output: 'The user denied this tool call. Do not retry it; continue without it.', isError: true }, false, true);
    }

    onEvent({ type: 'tool_running', id: tc.id });
    const result = await manager.callTool(name, call.args);
    if (!result.isError) succeeded.add(signature);
    return settle(result);
  };

  let forceFinal = false;
  for (let round = 1; round <= maxRounds + 1; round++) {
    if (isStopped()) return finish('stopped');
    // The extra round has no tools: the model must answer from what it has.
    const finalRound = forceFinal || round > maxRounds;
    const tools = finalRound ? [] : manager.getOpenAITools(disabled);
    onEvent({ type: 'round_start', round });

    const response = await complete({
      messages: [...history],
      tools: tools.length ? tools : undefined,
      onContent: (text) => onEvent({ type: 'content', text }),
      onReasoning: (text) => onEvent({ type: 'reasoning', text }),
    });
    const content = (response.content ?? '').trim();
    const reasoning = (response.reasoning ?? '').trim();
    const toolCalls: ToolCall[] = finalRound
      ? []
      : response.toolCalls.map((tc) => ({
          id: tc.id || newCallId(),
          type: 'function',
          function: { name: tc.function.name, arguments: tc.function.arguments ?? '' },
        }));

    // Reasoning is shown to the user but not sent back: in a 4k context, a few rounds of
    // re-sent thinking would crowd out the tool results the model actually needs.
    push(toolCalls.length ? { role: 'assistant', content, tool_calls: toolCalls } : { role: 'assistant', content });
    onEvent({ type: 'assistant', content, reasoning, toolCalls });

    if (response.interrupted || isStopped()) return finish('stopped');
    if (toolCalls.length === 0) return finish(offerTools && round > maxRounds ? 'max_rounds' : 'final');

    let repeatsOnly = true;
    for (const tc of toolCalls) {
      const { result, repeat } = await executeCall(tc);
      if (!repeat) repeatsOnly = false;
      push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: result.output });
      if (isStopped()) return finish('stopped');
    }
    // Every call in this round repeated an earlier successful one: the model is looping.
    if (repeatsOnly) forceFinal = true;
  }
  return finish('max_rounds');
}

/**
 * Keep the system prompt plus as many whole recent turns as fit in `maxChars`. Turns start at
 * a user message, so an assistant tool call is never separated from its tool results. The
 * latest turn is always kept.
 */
export function trimHistory(messages: ChatMessage[], maxChars: number): ChatMessage[] {
  const system = messages.filter((m) => m.role === 'system');
  const rest = messages.filter((m) => m.role !== 'system');
  const turns: ChatMessage[][] = [];
  for (const message of rest) {
    if (message.role === 'user' || turns.length === 0) turns.push([]);
    turns[turns.length - 1].push(message);
  }
  const size = (turn: ChatMessage[]) =>
    turn.reduce((n, m) => n + m.content.length + ('tool_calls' in m && m.tool_calls ? JSON.stringify(m.tool_calls).length : 0), 0);

  const kept: ChatMessage[][] = [];
  let total = 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    total += size(turns[i]);
    if (kept.length > 0 && total > maxChars) break;
    kept.unshift(turns[i]);
  }
  return [...system, ...kept.flat()];
}

/** Agent-mode system prompt: the user's prompt plus short tool guidance and server instructions. */
export function buildAgentSystemPrompt(basePrompt: string, manager: McpManager, disabled: DisabledMap = {}, now = new Date()): string {
  const lines = [
    basePrompt.trim(),
    '',
    'You can call tools. Use one only when it helps with the request; otherwise answer directly. ' +
      'After a tool returns, use its result to answer the user.',
  ];
  const enabled = new Set(manager.getOpenAITools(disabled).map((t) => t.function.name.split('__')[1]));
  for (const [id, state] of Object.entries(manager.getAllStates())) {
    if (state.status !== 'connected' || !enabled.has(id) || !state.instructions) continue;
    // Server instructions come from the server, so keep them short like tool descriptions.
    const text = state.instructions.replace(/\s+/g, ' ').trim().slice(0, 300);
    lines.push(`- ${state.name}: ${text}`);
  }
  lines.push(`Current date: ${now.toDateString()}.`);
  return lines.join('\n');
}
