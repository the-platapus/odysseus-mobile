// Convert the persisted chat log into OpenAI-style messages for llama.rn's chat templates.
//
// Chat log entries (saved by useChatStore):
//   { role: 'user', text }
//   { role: 'assistant', text, model?, toolCalls? }   (model: file name of the model that wrote it)
//   { role: 'tool', id, name, args, output?, status }

import type { ChatMessage, ToolCall } from './agentLoop';

export type ToolEntryStatus = 'approval' | 'running' | 'done' | 'error' | 'denied';

export type ChatLogEntry =
  | { role: 'user'; text: string; time?: string }
  | { role: 'assistant'; text: string; time?: string; model?: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; id: string; name: string; args: string; output?: string; status: ToolEntryStatus; time?: string };

const NOT_EXECUTED = 'This tool call was not executed.';

/**
 * Every assistant tool call is immediately followed by its tool result (synthesized when the
 * call never ran, e.g. the app closed mid-turn), consecutive user messages are merged and
 * empty assistant messages dropped, because many chat templates reject anything else.
 */
export function chatLogToMessages(log: ChatLogEntry[], systemPrompt: string): ChatMessage[] {
  const outputs = new Map<string, string>();
  for (const entry of log) {
    if (entry.role === 'tool' && entry.output !== undefined) outputs.set(entry.id, entry.output);
  }

  const messages: ChatMessage[] = [];
  if (systemPrompt.trim()) messages.push({ role: 'system', content: systemPrompt });
  for (const entry of log) {
    if (entry.role === 'user') {
      const last = messages[messages.length - 1];
      if (last?.role === 'user') last.content += `\n\n${entry.text}`;
      else messages.push({ role: 'user', content: entry.text });
    } else if (entry.role === 'assistant') {
      const text = (entry.text ?? '').trim();
      if (entry.toolCalls?.length) {
        messages.push({ role: 'assistant', content: text, tool_calls: entry.toolCalls });
        for (const call of entry.toolCalls) {
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.function.name,
            content: outputs.get(call.id) ?? NOT_EXECUTED,
          });
        }
      } else if (text) {
        messages.push({ role: 'assistant', content: text });
      }
    }
    // Tool entries were emitted next to their assistant message above.
  }
  return messages;
}
