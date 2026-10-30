import { View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { useState } from 'react';
import { displayToolName } from '../mcp/manager';
import theme from '../../theme.json';

const monoFont = Platform.OS === 'ios' ? 'Menlo' : 'monospace';
const OK_GREEN = '#6bc46d';

const STATUS = {
  approval: { label: 'needs approval', color: theme.colors.red },
  running: { label: 'running', color: theme.colors.border },
  done: { label: 'done', color: OK_GREEN },
  error: { label: 'error', color: theme.colors.red },
  denied: { label: 'denied', color: theme.colors.red },
};

const prettyArgs = (raw) => {
  if (!raw) return '{}';
  try {
    return JSON.stringify(JSON.parse(raw), null, 1).replace(/\n\s*/g, ' ');
  } catch {
    return raw;
  }
};

/**
 * One tool call in the chat. While it needs approval and the turn is still live (`canApprove`),
 * it shows the allow/deny buttons, like Odysseus' approval card.
 */
export default function ToolCallCard({ entry, canApprove, onApprove, onApproveForChat, onDeny }) {
  const [expanded, setExpanded] = useState(false);
  const status = STATUS[entry.status] ?? STATUS.running;
  const awaiting = entry.status === 'approval';
  const output = entry.output ?? '';
  const preview = output.split('\n').slice(0, 3).join('\n');
  const hasMore = output.length > preview.length;

  return (
    <View style={[styles.card, awaiting && styles.cardAwaiting]}>
      <View style={styles.headerRow}>
        <Text style={styles.name} numberOfLines={1}>⚙ {displayToolName(entry.name)}</Text>
        <Text style={[styles.status, { color: status.color }]}>[{awaiting && !canApprove ? 'expired' : status.label}]</Text>
      </View>
      <Text style={styles.args} numberOfLines={expanded ? undefined : 2} selectable>{prettyArgs(entry.args)}</Text>

      {awaiting && canApprove && (
        <View style={styles.approvalRow}>
          <TouchableOpacity onPress={onApprove} style={styles.approvalBtn}>
            <Text style={[styles.approvalText, { color: OK_GREEN }]}>[ALLOW]</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={onApproveForChat} style={styles.approvalBtn}>
            <Text style={[styles.approvalText, { color: theme.colors.fg }]}>[ALLOW IN CHAT]</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={onDeny} style={styles.approvalBtn}>
            <Text style={[styles.approvalText, { color: theme.colors.red }]}>[DENY]</Text>
          </TouchableOpacity>
        </View>
      )}

      {!!output && (
        <TouchableOpacity activeOpacity={0.7} onPress={() => setExpanded(!expanded)} disabled={!hasMore}>
          <Text style={[styles.output, entry.status === 'error' && { color: theme.colors.red }]} selectable>
            {expanded ? output : preview}
          </Text>
          {hasMore && <Text style={styles.more}>{expanded ? '[less]' : '[more]'}</Text>}
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    alignSelf: 'flex-start',
    maxWidth: '95%',
    minWidth: '60%',
    marginBottom: 12,
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.bg,
  },
  cardAwaiting: {
    borderColor: theme.colors.red,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 8,
  },
  name: {
    flexShrink: 1,
    color: theme.colors.fg,
    fontFamily: monoFont,
    fontSize: 12,
    fontWeight: 'bold',
  },
  status: {
    fontFamily: monoFont,
    fontSize: 11,
    fontWeight: 'bold',
  },
  args: {
    marginTop: 4,
    color: theme.colors.border,
    fontFamily: monoFont,
    fontSize: 11,
  },
  approvalRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 14,
    marginTop: 10,
  },
  approvalBtn: {
    paddingVertical: 4,
  },
  approvalText: {
    fontFamily: monoFont,
    fontSize: 12,
    fontWeight: 'bold',
  },
  output: {
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: theme.colors.panel,
    color: theme.colors.fg,
    fontFamily: monoFont,
    fontSize: 11,
    lineHeight: 16,
  },
  more: {
    marginTop: 4,
    color: theme.colors.border,
    fontFamily: monoFont,
    fontSize: 11,
  },
});
