// "Export chat", modelled on WhatsApp's: the conversation as a plain .txt file with one line per
// message ("date, time - sender: text"; a message's extra lines follow without a prefix), handed
// to the system share sheet. Unlike WhatsApp it names the model that wrote each reply and keeps
// the model's thinking and its tool calls, since they're part of how each reply came about.

import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import appJson from '../../app.json';
import type { ChatLogEntry, ToolEntryStatus } from '../mcp/chatLog';
import { displayToolName } from '../mcp/manager';

// Tool output can be a whole file; the export keeps the start of it.
const MAX_TOOL_OUTPUT = 2000;

const TOOL_STATUS: Record<ToolEntryStatus, string> = {
  approval: ' (waiting for approval)',
  running: ' (running)',
  done: '',
  error: ' (error)',
  denied: ' (denied)',
};

/** "31/10/2026, 12:04 PM", in the phone's own date format like WhatsApp's exports. */
const stamp = (ms: number) => {
  const d = new Date(ms);
  return `${d.toLocaleDateString()}, ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
};

// Messages from before `at` was saved only have their time.
const when = (entry: ChatLogEntry) => (entry.at ? stamp(entry.at) : entry.time ?? '');

const line = (entry: ChatLogEntry, sender: string, text: string) => {
  const time = when(entry);
  return `${time ? `${time} - ` : ''}${sender}: ${text.trim()}`;
};

const clip = (text: string) =>
  text.length > MAX_TOOL_OUTPUT ? `${text.slice(0, MAX_TOOL_OUTPUT)}… (${text.length - MAX_TOOL_OUTPUT} more characters)` : text;

export function formatChatExport(title: string, log: ChatLogEntry[], exportedAt = Date.now()): string {
  const models = [...new Set(log.flatMap((e) => (e.role === 'assistant' && e.model ? [e.model] : [])))];
  const out = [
    title,
    `Exported from odysseus-mobile ${appJson.expo.version} on ${stamp(exportedAt)}`,
    ...(models.length ? [`Models: ${models.join(', ')}`] : []),
    '',
  ];
  for (const e of log) {
    if (e.role === 'user') {
      out.push(line(e, 'You', e.text));
    } else if (e.role === 'assistant') {
      const model = e.model || 'Assistant';
      const sender = e.persona ? `${e.persona} (${model})` : model;
      if (e.reasoning) out.push(line(e, `${sender} (thinking)`, e.reasoning));
      const stopped = e.stoppedInBackground ? ' (stopped when the app left the screen)' : '';
      // A round that only called tools has no text; its tool lines stand in for it.
      if (e.text || stopped) out.push(line(e, sender, `${e.text}${stopped}`));
    } else {
      out.push(line(e, `Tool ${displayToolName(e.name)}`, `${e.args}${TOOL_STATUS[e.status] ?? ''}`));
      if (e.output) out.push(clip(e.output.trim()));
    }
  }
  return out.join('\n') + '\n';
}

/** Keeps the title readable as a file name on every platform. */
const fileNameFor = (title: string) =>
  title.replace(/[\\/:*?"<>|\r\n]+/g, ' ').replace(/\s+/g, ' ').replace(/[.\s]+$/, '').trim().slice(0, 60) || 'Chat';

/** Write the chat to a .txt file and open the share sheet, like WhatsApp's "Export chat". */
export async function shareChatExport(title: string, log: ChatLogEntry[]) {
  if (!(await Sharing.isAvailableAsync())) throw new Error("Sharing isn't available on this device.");
  const file = new File(Paths.cache, `Odysseus Chat - ${fileNameFor(title)}.txt`);
  file.create({ overwrite: true });
  file.write(formatChatExport(title, log));
  await Sharing.shareAsync(file.uri, { mimeType: 'text/plain', UTI: 'public.plain-text', dialogTitle: 'Export chat' });
}
