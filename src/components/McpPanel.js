import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  ActivityIndicator,
  StyleSheet,
  Platform,
  LayoutAnimation,
} from 'react-native';
import { useState, useEffect } from 'react';
import { useMcp } from '../hooks/useMcp';
import {
  setAgentMode,
  setServerEnabled,
  reconnectServer,
  removeServer,
  setToolEnabled,
  addHttpServer,
  choosePhoneFolder,
  resetFsRootToWorkspace,
  importFilesToWorkspace,
  listFsRoot,
} from '../mcp/runtime';
import theme from '../../theme.json';

const monoFont = Platform.OS === 'ios' ? 'Menlo' : 'monospace';
const OK_GREEN = '#6bc46d';

const STATUS_COLORS = {
  connected: OK_GREEN,
  connecting: theme.colors.border,
  error: theme.colors.red,
  timeout: theme.colors.red,
  disconnected: theme.colors.border,
};

const TOOL_SUPPORT_TEXT = {
  native: 'Loaded model: native tool calling.',
  generic: 'Loaded model: generic JSON tool calling. Works, but small models are less reliable at it.',
  none: 'Loaded model has no chat template, so it can’t call tools. Chat still works.',
};

const formatSize = (bytes) => {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const runSafely = async (fn, label) => {
  try {
    await fn();
  } catch (e) {
    console.log(`App Alert: ${label}: ${e.message}`);
    alert(`${label}: ${e.message}`);
  }
};

function Toggle({ on, onPress, disabled }) {
  return (
    <TouchableOpacity onPress={onPress} disabled={disabled} style={styles.toggle}>
      <Text style={[styles.toggleText, { color: on ? OK_GREEN : theme.colors.border }, disabled && { opacity: 0.5 }]}>
        {on ? '[ON]' : '[OFF]'}
      </Text>
    </TouchableOpacity>
  );
}

function ServerCard({ config, state, tools }) {
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const status = config.enabled ? state?.status ?? 'connecting' : 'disconnected';
  const isBuiltin = config.transport === 'builtin';

  const act = async (fn, label) => {
    setBusy(true);
    await runSafely(fn, label);
    setBusy(false);
  };

  return (
    <View style={styles.card}>
      <TouchableOpacity
        onPress={() => {
          LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
          setExpanded(!expanded);
        }}
      >
        <View style={styles.rowBetween}>
          <Text style={styles.cardTitle} numberOfLines={1}>{config.name}</Text>
          <Text style={[styles.statusText, { color: STATUS_COLORS[status] }]}>● {status}</Text>
        </View>
        <Text style={styles.cardSub} numberOfLines={1}>
          {isBuiltin ? 'built-in' : config.url}
          {status === 'connected' ? ` · ${tools.length} tools` : ''}
          {'  '}{expanded ? '▾' : '▸'}
        </Text>
        {config.enabled && !!state?.error && <Text style={styles.errorText}>{state.error}</Text>}
      </TouchableOpacity>

      <View style={[styles.rowBetween, { marginTop: 10 }]}>
        <View style={{ flexDirection: 'row', gap: 16 }}>
          {config.enabled && (
            <TouchableOpacity disabled={busy} onPress={() => act(() => reconnectServer(config.id), 'Reconnect failed')}>
              <Text style={styles.actionText}>[RECONNECT]</Text>
            </TouchableOpacity>
          )}
          {!isBuiltin && (
            <TouchableOpacity disabled={busy} onPress={() => act(() => removeServer(config.id), 'Delete failed')}>
              <Text style={[styles.actionText, { color: theme.colors.red }]}>[DEL]</Text>
            </TouchableOpacity>
          )}
          {busy && <ActivityIndicator size="small" color={theme.colors.fg} />}
        </View>
        <Toggle
          on={config.enabled}
          disabled={busy}
          onPress={() => act(() => setServerEnabled(config.id, !config.enabled), 'Update failed')}
        />
      </View>

      {expanded && status === 'connected' && (
        <View style={styles.toolList}>
          {tools.length === 0 && <Text style={styles.muted}>This server has no tools.</Text>}
          {tools.map((tool) => (
            <View key={tool.name} style={styles.toolRow}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.toolName, tool.isDisabled && { color: theme.colors.border }]}>
                  {tool.name}
                  <Text style={{ color: tool.readOnly ? OK_GREEN : theme.colors.red, fontWeight: 'normal' }}>
                    {tool.readOnly ? '  read' : '  write · asks first'}
                  </Text>
                </Text>
                {!!tool.description && <Text style={styles.toolDesc} numberOfLines={2}>{tool.description}</Text>}
              </View>
              <Toggle
                on={!tool.isDisabled}
                onPress={() => runSafely(() => setToolEnabled(config.id, tool.name, tool.isDisabled), 'Update failed')}
              />
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

function ServersTab({ mcp, toolSupport, isModelReady }) {
  const allTools = mcp.manager.getAllTools(mcp.disabled);
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.tabContent}>
      <View style={[styles.card, styles.rowBetween]}>
        <View style={{ flex: 1, paddingRight: 12 }}>
          <Text style={styles.cardTitle}>Agent mode</Text>
          <Text style={styles.cardSub}>
            Let the model call the tools below. {mcp.enabledToolCount} tools enabled.
          </Text>
        </View>
        <Toggle on={mcp.settings.agentMode} onPress={() => runSafely(() => setAgentMode(!mcp.settings.agentMode), 'Update failed')} />
      </View>
      <Text style={styles.muted}>{isModelReady ? TOOL_SUPPORT_TEXT[toolSupport] : 'No model loaded.'}</Text>

      <Text style={styles.sectionTitle}>Servers</Text>
      {mcp.settings.servers.map((config) => (
        <ServerCard
          key={config.id}
          config={config}
          state={mcp.states[config.id]}
          tools={allTools.filter((t) => t.serverId === config.id)}
        />
      ))}
      <Text style={styles.muted}>
        Tools that only read run straight away. Tools that change something ask you first in the chat.
      </Text>
    </ScrollView>
  );
}

function AddServerTab({ onAdded }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await addHttpServer({ name, url, token });
      if (result.saved) {
        setName('');
        setUrl('');
        setToken('');
        // The server list shows whether it connected, and the error if it didn't.
        onAdded();
      } else {
        setError(result.error);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.tabContent} keyboardShouldPersistTaps="handled">
      <Text style={styles.label}>Name</Text>
      <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="My server" placeholderTextColor={theme.colors.border} />
      <Text style={styles.label}>URL</Text>
      <TextInput
        style={styles.input}
        value={url}
        onChangeText={setUrl}
        placeholder="https://example.com/mcp"
        placeholderTextColor={theme.colors.border}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
      />
      <Text style={styles.label}>Access token (optional)</Text>
      <TextInput
        style={styles.input}
        value={token}
        onChangeText={setToken}
        placeholder="Sent as: Authorization: Bearer <token>"
        placeholderTextColor={theme.colors.border}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
      />
      <TouchableOpacity style={[styles.primaryBtn, busy && { opacity: 0.5 }]} onPress={submit} disabled={busy}>
        {busy ? <ActivityIndicator color={theme.colors.fg} /> : <Text style={styles.primaryBtnText}>Connect & Save</Text>}
      </TouchableOpacity>
      {!!error && <Text style={styles.errorText}>{error}</Text>}
      <Text style={styles.muted}>
        The server must speak MCP over Streamable HTTP. The token is stored on this device.
        Release builds on Android only allow https:// addresses.
      </Text>
    </ScrollView>
  );
}

function FilesTab({ mcp }) {
  const [entries, setEntries] = useState(null);
  const [busy, setBusy] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const rootUri = mcp.fsRoot?.dir?.uri;
  const root = mcp.fsRoot;

  useEffect(() => {
    let cancelled = false;
    listFsRoot().then(
      (list) => !cancelled && setEntries(list),
      (e) => {
        console.log(`App Alert: Failed to list files: ${e.message}`);
        if (!cancelled) setEntries([]);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [rootUri, reloadKey]);

  const act = async (fn, label) => {
    setBusy(true);
    await runSafely(fn, label);
    setReloadKey((k) => k + 1);
    setBusy(false);
  };

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.tabContent}>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>File tools work in</Text>
        <Text style={[styles.cardSub, { color: theme.colors.fg }]}>{root ? root.label : 'the app workspace'}</Text>
        {!!root?.error && <Text style={styles.errorText}>{root.error}</Text>}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 16, marginTop: 12 }}>
          <TouchableOpacity disabled={busy} onPress={() => act(choosePhoneFolder, 'Could not open folder')}>
            <Text style={styles.actionText}>[PICK PHONE FOLDER]</Text>
          </TouchableOpacity>
          {root && !root.isWorkspace && (
            <TouchableOpacity disabled={busy} onPress={() => act(resetFsRootToWorkspace, 'Update failed')}>
              <Text style={styles.actionText}>[USE APP WORKSPACE]</Text>
            </TouchableOpacity>
          )}
          {(!root || root.isWorkspace) && (
            <TouchableOpacity disabled={busy} onPress={() => act(importFilesToWorkspace, 'Import failed')}>
              <Text style={styles.actionText}>[IMPORT FILES]</Text>
            </TouchableOpacity>
          )}
          {busy && <ActivityIndicator size="small" color={theme.colors.fg} />}
        </View>
      </View>

      <Text style={styles.sectionTitle}>{'Contents of "/"'}</Text>
      {entries === null && <ActivityIndicator color={theme.colors.fg} />}
      {entries?.length === 0 && <Text style={styles.muted}>Empty. Import files, or ask the model to create some.</Text>}
      {entries
        ?.slice()
        .sort((a, b) => (a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1))
        .map((e) => (
          <View key={e.name} style={styles.fileRow}>
            <Text style={styles.fileName} numberOfLines={1}>{e.isDirectory ? `${e.name}/` : e.name}</Text>
            <Text style={styles.muted}>{e.isDirectory ? 'folder' : formatSize(e.size)}</Text>
          </View>
        ))}
      <Text style={styles.muted}>
        The workspace is private to this app. A picked phone folder gives the model real access to
        that folder, including deleting files (after you approve each change).
      </Text>
    </ScrollView>
  );
}

/** Settings for MCP tool servers, the mobile counterpart of Odysseus' MCP settings page. */
export default function McpPanel({ onClose, toolSupport, isModelReady }) {
  const mcp = useMcp();
  const [tab, setTab] = useState('servers');

  const changeTab = (next) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setTab(next);
  };

  const tabs = [
    ['servers', '[SERVERS]'],
    ['add', '[ADD]'],
    ['files', '[FILES]'],
  ];

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.header}>
        <View style={{ flexDirection: 'row', gap: 20 }}>
          {tabs.map(([key, label]) => (
            <TouchableOpacity key={key} onPress={() => changeTab(key)}>
              <Text style={[styles.tabText, { color: tab === key ? theme.colors.red : theme.colors.border }]}>{label}</Text>
            </TouchableOpacity>
          ))}
        </View>
        <TouchableOpacity onPress={onClose}>
          <Text style={[styles.tabText, { color: theme.colors.fg }]}>[X]</Text>
        </TouchableOpacity>
      </View>
      {tab === 'servers' && <ServersTab mcp={mcp} toolSupport={toolSupport} isModelReady={isModelReady} />}
      {tab === 'add' && <AddServerTab onAdded={() => changeTab('servers')} />}
      {tab === 'files' && <FilesTab mcp={mcp} />}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 15,
    paddingVertical: 15,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  tabText: {
    fontSize: 16,
    fontWeight: 'bold',
    fontFamily: monoFont,
  },
  tabContent: {
    padding: 15,
    gap: 12,
    paddingBottom: 40,
  },
  sectionTitle: {
    color: theme.colors.fg,
    fontFamily: monoFont,
    fontSize: 14,
    fontWeight: 'bold',
    marginTop: 8,
  },
  card: {
    backgroundColor: theme.colors.panel,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 8,
    padding: 12,
  },
  rowBetween: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  cardTitle: {
    flexShrink: 1,
    color: theme.colors.fg,
    fontFamily: monoFont,
    fontSize: 14,
    fontWeight: 'bold',
  },
  cardSub: {
    color: theme.colors.border,
    fontFamily: monoFont,
    fontSize: 12,
    marginTop: 4,
  },
  statusText: {
    fontFamily: monoFont,
    fontSize: 12,
    marginLeft: 8,
  },
  errorText: {
    color: theme.colors.red,
    fontFamily: monoFont,
    fontSize: 12,
    marginTop: 6,
  },
  actionText: {
    color: theme.colors.fg,
    fontFamily: monoFont,
    fontSize: 12,
    fontWeight: 'bold',
  },
  toggle: {
    paddingVertical: 4,
    paddingLeft: 8,
  },
  toggleText: {
    fontFamily: monoFont,
    fontSize: 13,
    fontWeight: 'bold',
  },
  toolList: {
    marginTop: 12,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    paddingTop: 8,
  },
  toolRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 6,
  },
  toolName: {
    color: theme.colors.fg,
    fontFamily: monoFont,
    fontSize: 12,
    fontWeight: 'bold',
  },
  toolDesc: {
    color: theme.colors.border,
    fontFamily: monoFont,
    fontSize: 11,
    marginTop: 2,
  },
  muted: {
    color: theme.colors.border,
    fontFamily: monoFont,
    fontSize: 12,
    lineHeight: 18,
  },
  label: {
    color: theme.colors.fg,
    fontFamily: monoFont,
    fontSize: 12,
    fontWeight: 'bold',
    marginBottom: -6,
  },
  input: {
    backgroundColor: theme.colors.panel,
    color: theme.colors.fg,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontFamily: monoFont,
    fontSize: 13,
  },
  primaryBtn: {
    backgroundColor: theme.colors.bg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 8,
    padding: 12,
    alignItems: 'center',
  },
  primaryBtnText: {
    color: theme.colors.red,
    fontFamily: monoFont,
    fontWeight: 'bold',
  },
  fileRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.panel,
  },
  fileName: {
    flex: 1,
    color: theme.colors.fg,
    fontFamily: monoFont,
    fontSize: 13,
  },
});
