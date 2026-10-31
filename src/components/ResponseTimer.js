// Live response timing. Each piece re-renders only itself (every 100 ms, as in Odysseus), not
// the chat around it.
import { useEffect, useState } from 'react';
import { Text } from 'react-native';
import LoadingWave from './LoadingWave';

/** Seconds since `since` (ms), updated every 100 ms. */
export function useElapsed(since) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, []);
  return since ? Math.max(0, (now - since) / 1000) : 0;
}

// Odysseus' wording while a reply has no tokens yet (static/js/chat.js, _ttftLabel).
const firstTokenLabel = (elapsed) => {
  const s = `${elapsed.toFixed(1)}s`;
  if (elapsed >= 120) return `Still waiting for first token · ${s}`;
  if (elapsed >= 60) return `Model pre-filling context · ${s}`;
  if (elapsed >= 20) return `Waiting for first token · ${s}`;
  return `Processing request · ${s}`;
};

/** In a reply bubble until its first token: "Processing request · 1.2s ▁▂▃". */
export function FirstTokenWait({ since, size = 14 }) {
  return <LoadingWave label={firstTokenLabel(useElapsed(since))} size={size} />;
}

/** "3.2s", counting up from `since`. */
export function ElapsedText({ since, style }) {
  return <Text style={style}>{useElapsed(since).toFixed(1)}s</Text>;
}
