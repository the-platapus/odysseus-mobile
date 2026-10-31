// Persisted MCP settings, the mobile stand-in for Odysseus' McpServer database rows: transport,
// URL, headers, enabled state and per-server disabled tool names. Built-ins are always present
// (like Odysseus' auto-registered servers) but can be switched off.

import type { DisabledMap, ServerSpec } from './manager';
import type { McpServer } from './server';
import { InProcessTransport, StreamableHttpTransport } from './transports';

export type McpServerConfig = {
  id: string;
  name: string;
  transport: 'builtin' | 'http';
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
  disabledTools: string[];
};

export type McpSettings = {
  version: 1;
  agentMode: boolean;
  servers: McpServerConfig[];
  /** Phone folder the files server is rooted at; null = the app's own workspace. */
  fsRootUri: string | null;
};

export const BUILTIN_SERVERS: McpServerConfig[] = [
  { id: 'files', name: 'Built-in: Files', transport: 'builtin', enabled: true, disabledTools: [] },
  { id: 'memory', name: 'Built-in: Memory', transport: 'builtin', enabled: true, disabledTools: [] },
];

export const DEFAULT_SETTINGS: McpSettings = {
  version: 1,
  agentMode: true,
  servers: BUILTIN_SERVERS,
  fsRootUri: null,
};

/** Merge stored settings with the current built-in list (new built-ins appear, removed ones go). */
export function normalizeSettings(stored: Partial<McpSettings> | null | undefined): McpSettings {
  const saved = Array.isArray(stored?.servers) ? stored!.servers : [];
  const builtinIds = new Set(BUILTIN_SERVERS.map((s) => s.id));
  const builtins = BUILTIN_SERVERS.map((def) => {
    const prev = saved.find((s) => s.id === def.id);
    return prev ? { ...def, enabled: prev.enabled !== false, disabledTools: prev.disabledTools ?? [] } : def;
  });
  const remote = saved
    .filter((s) => s && s.transport === 'http' && !builtinIds.has(s.id) && typeof s.url === 'string')
    .map((s) => ({ ...s, enabled: s.enabled !== false, disabledTools: s.disabledTools ?? [] }));
  return {
    version: 1,
    // On unless saved as off. Settings saved before this default changed carry `false` even if
    // the switch was never touched, so those phones stay off until it's switched on.
    agentMode: stored?.agentMode !== false,
    servers: [...builtins, ...remote],
    fsRootUri: typeof stored?.fsRootUri === 'string' ? stored.fsRootUri : null,
  };
}

export const disabledMapFrom = (servers: McpServerConfig[]): DisabledMap =>
  Object.fromEntries(servers.map((s) => [s.id, s.disabledTools]));

export function validateServerUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'Enter a full URL, e.g. https://example.com/mcp';
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return 'The URL must start with https:// or http://';
  return null;
}

export function specFromConfig(config: McpServerConfig, builtins: Record<string, () => McpServer>): ServerSpec {
  if (config.transport === 'builtin') {
    const factory = builtins[config.id];
    return {
      id: config.id,
      name: config.name,
      builtin: true,
      createTransport: () => {
        if (!factory) throw new Error(`Unknown built-in server: ${config.id}`);
        return new InProcessTransport(factory());
      },
    };
  }
  return {
    id: config.id,
    name: config.name,
    builtin: false,
    createTransport: () => new StreamableHttpTransport(config.url ?? '', { headers: config.headers }),
  };
}
