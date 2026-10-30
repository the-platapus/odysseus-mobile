import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { disabledMapFrom } from '../mcp/config';
import {
  getFsRoot,
  getRuntimeVersion,
  getSettings,
  mcpManager,
  startMcp,
  subscribeRuntime,
} from '../mcp/runtime';

const subscribeManager = (listener: () => void) => mcpManager.subscribe(listener);
const getManagerGeneration = () => mcpManager.generation;

/** MCP settings and live server state. Backed by module-level state, so any number of components can use it. */
export function useMcp() {
  const runtimeVersion = useSyncExternalStore(subscribeRuntime, getRuntimeVersion);
  const generation = useSyncExternalStore(subscribeManager, getManagerGeneration);

  useEffect(() => {
    startMcp().catch((e) => console.log(`App Alert: MCP startup failed: ${e?.message ?? e}`));
  }, []);

  return useMemo(() => {
    const settings = getSettings();
    const disabled = disabledMapFrom(settings.servers);
    return {
      manager: mcpManager,
      settings,
      disabled,
      states: mcpManager.getAllStates(),
      enabledToolCount: mcpManager.getOpenAITools(disabled).length,
      fsRoot: getFsRoot(),
    };
    // Recomputed when the runtime or the manager reports a change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtimeVersion, generation]);
}
