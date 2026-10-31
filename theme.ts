// The app's built-in themes, listed in the Theme screen (☰ → Theme) in this order. To add one,
// add an entry: its key is the name people see. Custom themes made in the app are saved on the
// phone (src/theme/), not here.
//
// Copied from Odysseus' static/js/theme.js: its THEMES colors, plus each theme's background
// pattern (THEME_DEFAULT_PATTERN) and effect color (THEME_DEFAULT_EFFECT_COLOR), which this app
// keeps but doesn't draw yet.

export type ThemeColors = {
  /** Screen background. */
  bg: string;
  /** Main text. */
  fg: string;
  /** Cards, menus, bubbles and inputs. */
  panel: string;
  /** Borders, and muted text such as timestamps. */
  border: string;
  /** Accent: the app title, active tabs, warnings and [DEL]. */
  red: string;
};

export type Theme = {
  colors: ThemeColors;
  bgPattern?: string;
  bgEffectColor?: string;
};

export const DEFAULT_THEME_NAME = 'Default';

export const THEMES: Record<string, Theme> = {
  // Odysseus' "midnight".
  Default: {
    colors: { bg: '#0d1117', fg: '#c9d1d9', panel: '#161b22', border: '#30363d', red: '#f85149' },
    bgPattern: 'rain',
    bgEffectColor: '#ffffff',
  },
  // Odysseus' "dark", which it shows as "original".
  Original: {
    colors: { bg: '#282c34', fg: '#9cdef2', panel: '#111111', border: '#355a66', red: '#e06c75' },
    bgPattern: 'none',
  },
  Light: {
    colors: { bg: '#f3f5f7', fg: '#26313a', panel: '#ffffff', border: '#cbd3da', red: '#b34d5c' },
    bgPattern: 'dots',
  },
  Cyberpunk: {
    colors: { bg: '#10121a', fg: '#9bdde0', panel: '#171a26', border: '#514b78', red: '#d45aa8' },
    bgPattern: 'synapse',
    bgEffectColor: '#62c4c7',
  },
  Retrowave: {
    colors: { bg: '#1a1a2e', fg: '#e94560', panel: '#16213e', border: '#533483', red: '#e94560' },
    bgPattern: 'embers',
  },
  Forest: {
    colors: { bg: '#1b2a1b', fg: '#a8d5a2', panel: '#142414', border: '#3d6b3d', red: '#7cb871' },
    bgPattern: 'petals',
  },
  // Odysseus' "ocean", which it shows as "starfield".
  Starfield: {
    colors: { bg: '#0b1a2c', fg: '#64d2ff', panel: '#091422', border: '#1e5074', red: '#4facfe' },
    bgPattern: 'starfield-depth',
  },
  Ume: {
    colors: { bg: '#271d2b', fg: '#f1d8e9', panel: '#1d1721', border: '#66475f', red: '#d98bb7' },
    bgPattern: 'petals',
    bgEffectColor: '#f5a0c0',
  },
  Terminal: {
    colors: { bg: '#0b1110', fg: '#b8e6c1', panel: '#080d0c', border: '#28553a', red: '#6bd38b' },
    bgPattern: 'ascii-fireflies',
  },
  Organs: {
    colors: { bg: '#0a0406', fg: '#efe1c8', panel: '#15080a', border: '#3a1519', red: '#c83240' },
    bgPattern: 'rain',
    bgEffectColor: '#451616',
  },
  // Odysseus also overrides its send button, bubble and input colors, which this app doesn't have.
  GPT: {
    colors: { bg: '#212121', fg: '#ececec', panel: '#171717', border: '#424242', red: '#949494' },
  },
  Claude: {
    colors: { bg: '#1f1e1b', fg: '#f5f1e8', panel: '#2b2926', border: '#514b43', red: '#d97757' },
  },
  Cute: {
    colors: { bg: '#fff4f7', fg: '#63394d', panel: '#fffafd', border: '#edc7d5', red: '#d65f88' },
    bgPattern: 'sparkles',
    bgEffectColor: '#ff8cb8',
  },
  Eclipse: {
    colors: { bg: '#17191c', fg: '#e8e4dc', panel: '#0f1113', border: '#3c4248', red: '#46c2b3' },
    bgPattern: 'starfield-depth',
    bgEffectColor: '#46c2b3',
  },
  Porcelain: {
    colors: { bg: '#edf0f2', fg: '#252a30', panel: '#ffffff', border: '#c7cdd2', red: '#3478c9' },
    bgPattern: 'dots',
  },
  Arcade: {
    colors: { bg: '#15131d', fg: '#f4e85c', panel: '#0b1720', border: '#305f68', red: '#ff4f91' },
    bgPattern: 'synapse',
    bgEffectColor: '#ff4f91',
  },
  Blueprint: {
    colors: { bg: '#10263b', fg: '#e8f1f5', panel: '#091a29', border: '#48758d', red: '#e6b84a' },
    bgPattern: 'dots',
    bgEffectColor: '#e6b84a',
  },
  Monolith: {
    colors: { bg: '#202020', fg: '#d8d8d2', panel: '#121212', border: '#50504b', red: '#b6e05c' },
    bgPattern: 'perlin-flow',
    bgEffectColor: '#b6e05c',
  },
  Yoyo: {
    colors: { bg: '#211f23', fg: '#dfdbd7', panel: '#141415', border: '#3e5146', red: '#e09d6c' },
    bgPattern: 'ascii-fireflies',
    bgEffectColor: '#b8e6c1',
  },
};
