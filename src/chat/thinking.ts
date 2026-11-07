// Thinking a model wrote into its reply as plain text. llama.cpp only lifts out what the chat
// template declares: Gemma 3 "Thinking" fine-tunes write <think> on a stock template that declares
// nothing, Gemma 4's parser knows its channel tags but not <think>, and with the think switch off
// templates like Qwen3's put an empty, closed block in the prompt, which uses up the one block the
// parser takes. So every reply comes through here, whatever the switch says. The tags are the ones
// Odysseus accepts (its src/text_helpers.py).

import type { ChatLogEntry } from '../mcp/chatLog';

export type SplitReply = { content: string; reasoning: string };

const NAME = '(?:think(?:ing)?|thought)';
const GEMMA_OPEN = '<|channel>thought';
const OPEN_TAGS = ['<think>', '<thinking>', '<thought>', GEMMA_OPEN];
// "<think/>" closes a block too.
const CLOSE_TAG = `<(?:/${NAME}|${NAME}/)>`;
const CLOSE = new RegExp(CLOSE_TAG, 'i');
const GEMMA_CLOSE = /<channel\|>/i;
// Code comes first and is skipped whole, so a reply can show these tags. Then opening tags, then
// Gemma's other channel tags, which only wrap the answer, then closing tags.
const SCAN = new RegExp(
  `\`\`\`[\\s\\S]*?(?:\`\`\`|$)|\`[^\`\\n]*\`|(<${NAME}>|<\\|channel>thought)|(<\\|channel>response\\s*|<channel\\|>)|${CLOSE_TAG}`,
  'gi'
);

const joinThoughts = (thoughts: (string | undefined)[]) =>
  thoughts.map((thought) => thought?.trim()).filter(Boolean).join('\n\n');

const startsLine = (text: string, index: number) => !text.slice(text.lastIndexOf('\n', index - 1) + 1, index).trim();

function endsLine(text: string, index: number) {
  const newline = text.indexOf('\n', index);
  return !text.slice(index, newline < 0 ? undefined : newline).trim();
}

/**
 * A reply's text with its thinking moved out. <think> has to start or end a line, or follow a
 * block, so a sentence about the tag stays as it is; Gemma's control tokens count anywhere.
 * `streaming` is for a reply still being written: what may be an opening tag on its way ("<thi")
 * stays hidden until it's more.
 */
export function splitThinking(text: string, streaming = false): SplitReply {
  const scan = new RegExp(SCAN);
  const thoughts: string[] = [];
  let content = '';
  let at = 0;
  for (let tag = scan.exec(text); tag; tag = scan.exec(text)) {
    if (tag[0][0] === '`') continue;
    const before = text.slice(at, tag.index);
    const end = tag.index + tag[0].length;
    if (tag[1]) {
      const gemma = tag[1][1] === '|';
      if (!gemma && before.trim() && !startsLine(text, tag.index) && !endsLine(text, end)) continue;
      const rest = text.slice(end);
      // With no closing tag it's still going, or was cut off: the rest of the reply is thinking.
      const close = (gemma ? GEMMA_CLOSE : CLOSE).exec(rest);
      content += before;
      thoughts.push(close ? rest.slice(0, close.index) : rest);
      at = close ? end + close.index + close[0].length : text.length;
    } else if (tag[2]) {
      content += before;
      at = end;
    } else {
      if (!endsLine(text, end)) continue;
      // A closing tag on its own: the block was opened in the prompt, so it's all thinking so far.
      // Unless nothing follows it or a block came before: then it's only a stray tag.
      const opened = !thoughts.length && (streaming || !!text.slice(end).trim());
      if (opened) thoughts.push(content + before);
      content = opened ? '' : content + before;
      at = end;
    }
    scan.lastIndex = at;
  }
  content = (content + text.slice(at)).trimStart();
  const unfinishedTag = streaming && OPEN_TAGS.some((tag) => tag.startsWith(content.toLowerCase()));
  return { content: unfinishedTag ? '' : content, reasoning: joinThoughts(thoughts) };
}

/** A reply as llama.cpp parsed it, with any thinking it left in the content moved out. */
export function readReply(parsed: { content?: string; reasoning_content?: string }, streaming = false): SplitReply {
  const { content, reasoning } = splitThinking(parsed.content ?? '', streaming);
  return { content, reasoning: joinThoughts([parsed.reasoning_content, reasoning]) };
}

/** A saved chat entry, for replies stored with their thinking still in the text. */
export function splitSavedThinking(entry: ChatLogEntry): ChatLogEntry {
  if (entry.role !== 'assistant' || !entry.text) return entry;
  const { content, reasoning } = readReply({ content: entry.text, reasoning_content: entry.reasoning });
  return { ...entry, text: content, ...(reasoning ? { reasoning } : {}) };
}
