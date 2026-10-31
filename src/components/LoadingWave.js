// The three-bar "wave" from Odysseus' spinner (static/js/spinner.js, its 'wave' animation), used
// wherever something is loading: a reply waiting for its first token, downloads, lists being
// fetched, a model loading. It's text, so it sits inline and takes the size of the text around it.
import { useEffect, useState } from 'react';
import { Platform, Text } from 'react-native';
import { theme } from '../theme';

const monoFont = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

// Odysseus' frames and speed.
export const WAVE_FRAMES = ['▁▂▃', '▂▃▄', '▃▄▅', '▄▅▆', '▅▆▅', '▆▅▄', '▅▄▃', '▄▃▂', '▃▂▁'];
const FRAME_MS = 150;

/** `label` goes before the wave, as Odysseus shows it ("Processing request · 1.2s ▁▂▃"). */
export default function LoadingWave({ label, color, size = 12, style }) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setFrame(f => (f + 1) % WAVE_FRAMES.length), FRAME_MS);
    return () => clearInterval(id);
  }, []);

  return (
    <Text
      style={[{ color: color ?? theme.colors.border, fontFamily: monoFont, fontSize: size }, style]}
      accessibilityRole="progressbar"
      accessibilityLabel={label || 'Loading'}
    >
      {label ? `${label} ` : ''}{WAVE_FRAMES[frame]}
    </Text>
  );
}
