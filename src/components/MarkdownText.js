import { View, Text, ScrollView, StyleSheet, Platform, Linking } from 'react-native';
import { Fragment, memo, useMemo } from 'react';
import { Marked } from 'marked';
import { theme, themed, useThemeVersion, isHexColor } from '../theme';

const monoFont = Platform.OS === 'ios' ? 'Menlo' : 'monospace';
const BULLETS = ['•', '◦', '▪'];
const SAFE_LINK = /^(https?:|mailto:)/i;
const BR_TAG = /^<br\s*\/?>$/i;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: '\u00a0' };

// GitHub-flavoured Markdown, parsed by marked, with every newline kept as a line break like the
// raw text it replaces. Underlined ("setext") headings are off: while a reply streams, the `-`
// that starts a list would turn the line above it into a heading until the rest arrived.
const markdown = new Marked({ gfm: true, breaks: true, tokenizer: { lheading: () => undefined } });

const lex = (text) => {
  try {
    return markdown.lexer(text.trimEnd());
  } catch {
    return null;
  }
};

const decode = (text) => text.replace(/&(amp|lt|gt|quot|apos|#39|nbsp);/g, (_, name) => ENTITIES[name]);
/** A theme color, partly see-through (`opacity` as two hex digits). */
const fade = (color, opacity) => (isHexColor(color) ? `${color}${opacity}` : color);
const openLink = (url) => Linking.openURL(url).catch(() => {});

/** The text of inline tokens as drawn, to pad table columns. */
const plain = (tokens) =>
  tokens
    .map((t) => {
      if (t.type === 'br' || (t.type === 'html' && BR_TAG.test(t.text))) return ' ';
      if (t.type === 'image') return t.text || 'image';
      if (t.tokens) return plain(t.tokens);
      return t.type === 'text' ? decode(t.text) : t.text ?? '';
    })
    .join('');

/**
 * Inline tokens as nested Text. A line break repeats the line's prefix (quote bars, list
 * indent) from `frames`; in a table cell (`frames` null) it's a space.
 */
function inlines(tokens, frames) {
  const lineBreak = (key) => (frames ? <Fragment key={key}>{'\n'}{prefix(frames, false)}</Fragment> : ' ');
  return tokens.map((t, i) => {
    switch (t.type) {
      case 'strong':
      case 'em':
      case 'del':
        return <Text key={i} style={styles[t.type]}>{inlines(t.tokens, frames)}</Text>;
      case 'codespan':
        return <Text key={i} style={styles.inlineCode}>{t.text}</Text>;
      case 'br':
        return lineBreak(i);
      case 'link':
      case 'image': {
        const label = t.type === 'image' ? t.text || 'image' : inlines(t.tokens, frames);
        if (!SAFE_LINK.test(t.href)) return <Fragment key={i}>{label}</Fragment>;
        return (
          <Text key={i} style={styles.link} accessibilityRole="link" onPress={() => openLink(t.href)}>
            {label}
          </Text>
        );
      }
      case 'html':
        return BR_TAG.test(t.text) ? lineBreak(i) : t.text;
      case 'text':
        return t.tokens ? <Fragment key={i}>{inlines(t.tokens, frames)}</Fragment> : decode(t.text);
      default:
        return t.text ?? t.raw;
    }
  });
}

/**
 * What starts a line inside quotes and lists: a bar per quote, then each list's marker on the
 * item's first line and spaces of the same width after it. A blank line keeps only the bars.
 */
function prefix(frames, blank) {
  return frames.map((frame, i) => {
    if (frame.quote) return <Text key={i} style={styles.quoteBar}>│ </Text>;
    if (blank) return null;
    if (frame.used) return ' '.repeat(frame.width);
    frame.used = true;
    return frame.marker;
  });
}

/**
 * The reply as runs of flowing text (each drawn as one selectable Text, so a long press copies
 * the whole run: iOS copies one Text at a time), broken only by code blocks, tables and rules.
 * Blank lines are kept as the model wrote them, one at most in a row.
 */
function layout(tokens) {
  const parts = [];
  let lines = null;

  const push = (entry) => {
    if (!lines) {
      if (entry.blank) return;
      lines = [];
      parts.push({ type: 'text', lines });
    }
    if (entry.blank && lines[lines.length - 1].blank) return;
    lines.push(entry);
  };
  const line = (frames, render) => {
    const start = prefix(frames, false);
    const content = render();
    const quoted = frames.some((frame) => frame.quote);
    push({ nodes: [...start, quoted ? <Text key="c" style={styles.quote}>{content}</Text> : <Fragment key="c">{content}</Fragment>] });
  };
  const blank = (frames) => push({ blank: true, nodes: prefix(frames, true) });
  const endText = () => {
    if (lines?.[lines.length - 1].blank) lines.pop();
    lines = null;
  };
  const block = (frames, part) => {
    endText();
    parts.push({ ...part, inset: frames.length });
  };

  const list = (t, frames) => {
    const depth = frames.filter((frame) => !frame.quote).length;
    t.items.forEach((item, n) => {
      if (n > 0 && t.loose) blank(frames);
      // An item with nothing in it yet ("2.", or the "*" of "- *Note*" as it streams) still shows
      // its marker, and a bullet shows as typed: it may be the start of the item's first word.
      const empty = item.tokens.every((token) => token.type === 'checkbox' || token.type === 'space');
      const marker = item.task
        ? item.checked ? '☑\uFE0E' : '☐'
        : t.ordered ? `${Number(t.start || 1) + n}.` : empty ? item.raw.trim() : BULLETS[depth % BULLETS.length];
      const width = (item.task ? 1 : marker.length) + 1;
      const itemFrames = [...frames, { marker: `${marker} `, width, used: false }];
      blocks(item.tokens, itemFrames);
      if (empty) line(itemFrames, () => null);
    });
  };

  const blocks = (tokens, frames) => {
    for (const t of tokens) {
      switch (t.type) {
        case 'space':
          blank(frames);
          break;
        case 'heading':
          line(frames, () => <Text style={styles[`h${Math.min(t.depth, 4)}`]}>{inlines(t.tokens, frames)}</Text>);
          break;
        case 'paragraph':
        case 'text':
          line(frames, () => (t.tokens ? inlines(t.tokens, frames) : decode(t.text)));
          break;
        case 'blockquote':
          blocks(t.tokens, [...frames, { quote: true }]);
          break;
        case 'list':
          list(t, frames);
          break;
        case 'code':
          block(frames, { type: 'code', lang: (t.lang || '').split(/\s/)[0], text: t.text });
          break;
        case 'table':
          block(frames, { type: 'table', token: t });
          break;
        case 'hr':
          block(frames, { type: 'rule' });
          break;
        case 'def':
        case 'checkbox':
          break;
        default:
          // HTML and anything newer than this code: as the model typed it.
          line(frames, () => t.text ?? t.raw);
      }
    }
  };

  blocks(tokens, []);
  endText();
  return parts;
}

/** A table as monospace columns padded with spaces, so it lines up in the app's font. */
function TableText({ token }) {
  const rows = [token.header, ...token.rows];
  const width = (cell) => (cell ? plain(cell.tokens).length : 0);
  const widths = token.header.map((_, c) => Math.max(1, ...rows.map((row) => width(row[c]))));
  const cells = (row) =>
    token.header.map((_, c) => {
      const room = widths[c] - width(row[c]);
      const before = token.align[c] === 'right' ? room : token.align[c] === 'center' ? Math.floor(room / 2) : 0;
      return (
        <Fragment key={c}>
          {c > 0 && <Text style={styles.grid}> │ </Text>}
          {' '.repeat(before)}
          {row[c] ? inlines(row[c].tokens, null) : ''}
          {' '.repeat(room - before)}
        </Fragment>
      );
    });

  return (
    <Text style={styles.table} selectable>
      <Text style={styles.strong}>{cells(token.header)}</Text>
      <Text style={styles.grid}>{'\n' + widths.map((w) => '─'.repeat(w)).join('─┼─')}</Text>
      {token.rows.map((row, r) => <Fragment key={r}>{'\n'}{cells(row)}</Fragment>)}
    </Text>
  );
}

/**
 * A model's reply with its Markdown drawn: bold, italics, code, headings, lists, quotes, links,
 * tables and rules. Half-written syntax shows as typed until it closes, and an unclosed code
 * fence is already a code block, so a streaming reply doesn't jump around. `style` is the
 * message text's own style; the raw Markdown stays in the chat log (and its export).
 */
function MarkdownText({ text, style }) {
  useThemeVersion();
  const tokens = useMemo(() => lex(text ?? ''), [text]);
  if (!tokens) return <Text style={style} selectable>{text}</Text>;

  return (
    <View style={styles.reply}>
      {layout(tokens).map((part, i) => {
        const inset = part.inset ? { marginLeft: 12 * part.inset } : null;
        switch (part.type) {
          case 'code':
            return (
              <View key={i} style={[styles.codeBlock, inset]}>
                {!!part.lang && <Text style={styles.codeLang}>{part.lang}</Text>}
                <ScrollView horizontal>
                  <Text style={styles.code} selectable>{part.text || ' '}</Text>
                </ScrollView>
              </View>
            );
          case 'table':
            return (
              <ScrollView key={i} horizontal style={inset}>
                <TableText token={part.token} />
              </ScrollView>
            );
          case 'rule':
            return <View key={i} style={[styles.rule, inset]} />;
          default:
            return (
              <Text key={i} style={style} selectable>
                {part.lines.map((entry, n) => <Fragment key={n}>{n > 0 && '\n'}{entry.nodes}</Fragment>)}
              </Text>
            );
        }
      })}
    </View>
  );
}

export default memo(MarkdownText);

const styles = themed(() => StyleSheet.create({
  reply: {
    gap: 8,
  },
  strong: {
    fontWeight: 'bold',
  },
  em: {
    fontStyle: 'italic',
  },
  del: {
    textDecorationLine: 'line-through',
  },
  link: {
    textDecorationLine: 'underline',
  },
  inlineCode: {
    fontFamily: monoFont,
    backgroundColor: fade(theme.colors.border, '99'),
  },
  h1: {
    fontSize: 18,
    lineHeight: 26,
    fontWeight: 'bold',
  },
  h2: {
    fontSize: 16,
    lineHeight: 24,
    fontWeight: 'bold',
  },
  h3: {
    fontSize: 15,
    lineHeight: 22,
    fontWeight: 'bold',
  },
  h4: {
    fontWeight: 'bold',
  },
  quoteBar: {
    color: theme.colors.border,
  },
  quote: {
    color: fade(theme.colors.fg, 'b3'),
  },
  codeBlock: {
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.bg,
  },
  codeLang: {
    marginBottom: 6,
    color: theme.colors.border,
    fontFamily: monoFont,
    fontSize: 11,
  },
  code: {
    color: theme.colors.fg,
    fontFamily: monoFont,
    fontSize: 12,
    lineHeight: 18,
  },
  table: {
    color: theme.colors.fg,
    fontFamily: monoFont,
    fontSize: 12,
    lineHeight: 18,
  },
  grid: {
    color: theme.colors.border,
  },
  rule: {
    height: 1,
    backgroundColor: theme.colors.border,
  },
}));
