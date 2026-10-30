import { Text, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { useState } from 'react';
import theme from '../../theme.json';

const monoFont = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

/**
 * The model's thinking above its reply: collapsed by default, like Odysseus keeps reasoning
 * out of the visible answer. While it streams (`live`), the latest lines show as a preview.
 */
export default function ThinkingBlock({ text, live }) {
  const [expanded, setExpanded] = useState(false);
  const preview = text.trim().split('\n').slice(-2).join('\n');

  return (
    <TouchableOpacity activeOpacity={0.7} onPress={() => setExpanded(!expanded)} style={styles.block}>
      <Text style={styles.header}>{expanded ? '▾' : '▸'} {live ? 'thinking…' : 'thought'}</Text>
      {(expanded || live) && (
        <Text style={styles.text} numberOfLines={expanded ? undefined : 2} selectable={expanded}>
          {expanded ? text.trim() : preview}
        </Text>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  block: {
    marginBottom: 8,
    paddingLeft: 8,
    borderLeftWidth: 2,
    borderLeftColor: theme.colors.border,
  },
  header: {
    color: theme.colors.border,
    fontFamily: monoFont,
    fontSize: 12,
    fontWeight: 'bold',
  },
  text: {
    marginTop: 4,
    color: theme.colors.border,
    fontFamily: monoFont,
    fontSize: 12,
    lineHeight: 18,
  },
});
