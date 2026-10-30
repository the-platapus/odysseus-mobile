// App-wide MCP runtime: one McpManager, the persisted settings, and the actions the UI uses.
// The counterpart of Odysseus' startup wiring (builtin_mcp.register_builtin_servers +
// McpManager.connect_all_enabled) and its /api/mcp routes.

import { createFilesystemServer } from './builtin/filesystem';
import { createMemoryServer } from './builtin/memory';
import {
  DEFAULT_SETTINGS,
  McpServerConfig,
  McpSettings,
  specFromConfig,
  validateServerUrl,
} from './config';
import {
  ExpoFsAdapter,
  FsRoot,
  asyncStorageMemoryStore,
  importFilesToWorkspace,
  loadSettings,
  pickPhoneFolder,
  resolveFsRoot,
  saveSettings,
} from './expoAdapters';
import { McpManager, slugifyServerId } from './manager';

export const mcpManager = new McpManager();

let settings: McpSettings = DEFAULT_SETTINGS;
let fsRoot: FsRoot | null = null;
let version = 0;
const listeners = new Set<() => void>();

const emit = () => {
  version++;
  for (const listener of listeners) listener();
};

export const subscribeRuntime = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const getRuntimeVersion = () => version;
export const getSettings = () => settings;
export const getFsRoot = () => fsRoot;

const builtinFactories = {
  files: () => {
    // Resolved on every (re)connect, so switching folders only needs a reconnect.
    fsRoot = resolveFsRoot(settings.fsRootUri);
    emit();
    return createFilesystemServer(new ExpoFsAdapter(fsRoot));
  },
  memory: () => createMemoryServer(asyncStorageMemoryStore),
};

const connect = (config: McpServerConfig) => mcpManager.connectServer(specFromConfig(config, builtinFactories));

const findServer = (id: string) => settings.servers.find((s) => s.id === id);

async function update(next: McpSettings) {
  settings = next;
  emit();
  await saveSettings(next);
}

const updateServer = (id: string, patch: Partial<McpServerConfig>) =>
  update({ ...settings, servers: settings.servers.map((s) => (s.id === id ? { ...s, ...patch } : s)) });

let started: Promise<void> | null = null;

/** Load settings and connect every enabled server concurrently. Safe to call repeatedly. */
export function startMcp(): Promise<void> {
  if (!started) {
    started = (async () => {
      settings = await loadSettings();
      emit();
      await Promise.all(settings.servers.filter((s) => s.enabled).map(connect));
    })();
  }
  return started;
}

export const setAgentMode = (agentMode: boolean) => update({ ...settings, agentMode });

export async function setServerEnabled(id: string, enabled: boolean) {
  const config = findServer(id);
  if (!config) return;
  await updateServer(id, { enabled });
  if (enabled) await connect({ ...config, enabled });
  else await mcpManager.disconnectServer(id);
}

export async function reconnectServer(id: string) {
  const config = findServer(id);
  if (config?.enabled) await connect(config);
}

export async function setToolEnabled(serverId: string, toolName: string, enabled: boolean) {
  const config = findServer(serverId);
  if (!config) return;
  const rest = config.disabledTools.filter((t) => t !== toolName);
  await updateServer(serverId, { disabledTools: enabled ? rest : [...rest, toolName] });
}

/**
 * Add a remote Streamable HTTP server and connect it. A valid server is saved even when it
 * can't be reached right now, like Odysseus; `error` then says why it isn't connected.
 */
export async function addHttpServer(input: { name: string; url: string; token?: string }): Promise<{ saved: boolean; error: string | null }> {
  const name = input.name.trim();
  const url = input.url.trim();
  if (!name) return { saved: false, error: 'Give the server a name.' };
  const invalid = validateServerUrl(url);
  if (invalid) return { saved: false, error: invalid };
  const token = input.token?.trim();
  const config: McpServerConfig = {
    id: slugifyServerId(name, settings.servers.map((s) => s.id)),
    name,
    transport: 'http',
    url,
    ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
    enabled: true,
    disabledTools: [],
  };
  await update({ ...settings, servers: [...settings.servers, config] });
  const ok = await connect(config);
  return { saved: true, error: ok ? null : mcpManager.getServerState(config.id).error ?? 'Could not connect.' };
}

export async function removeServer(id: string) {
  const config = findServer(id);
  if (!config || config.transport === 'builtin') return;
  await mcpManager.disconnectServer(id);
  await update({ ...settings, servers: settings.servers.filter((s) => s.id !== id) });
}

async function setFsRootUri(fsRootUri: string | null) {
  await update({ ...settings, fsRootUri });
  if (findServer('files')?.enabled) await reconnectServer('files');
  else fsRoot = resolveFsRoot(fsRootUri);
  emit();
}

/** Let the user pick a phone folder for the files server. Returns false if they cancelled. */
export async function choosePhoneFolder(): Promise<boolean> {
  const dir = await pickPhoneFolder();
  if (!dir) return false;
  await setFsRootUri(dir.uri);
  return true;
}

export const resetFsRootToWorkspace = () => setFsRootUri(null);

export { importFilesToWorkspace };

/** Top-level entries of the files server's root, for the panel. */
export async function listFsRoot() {
  const root = fsRoot ?? resolveFsRoot(settings.fsRootUri);
  return new ExpoFsAdapter(root).list([]);
}
