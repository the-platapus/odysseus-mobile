// The theme in use, and switching it. `theme` is one shared object whose values change in place
// when another theme is applied, so components keep reading theme.colors.* while they render.
// Values made with themed() (style sheets, color tables) are rebuilt in place at that moment, and
// useThemeVersion() re-renders whoever calls it: App does, so the whole app redraws.
// The choice and any custom themes (like Odysseus, at most 8) are saved on the phone.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';
import { DEFAULT_THEME_NAME, THEMES, type Theme, type ThemeColors } from '../../theme';

export { DEFAULT_THEME_NAME, THEMES };
export type { Theme, ThemeColors };

const SELECTED_KEY = 'theme_v1';
const CUSTOM_KEY = 'custom_themes_v1';
export const MAX_CUSTOM_THEMES = 8;

const copy = (t: Theme): Theme => ({ ...t, colors: { ...t.colors } });

/** The theme in use. Read it while rendering: its values change when another theme is applied. */
export const theme: Theme & { name: string } = { name: DEFAULT_THEME_NAME, ...copy(THEMES[DEFAULT_THEME_NAME]) };

const rebuilders: (() => void)[] = [];

/** A value built from the theme (a StyleSheet, a table of colors), rebuilt in place when the theme changes. */
export function themed<T extends object>(make: () => T): T {
  const value = make();
  rebuilders.push(() => Object.assign(value, make()));
  return value;
}

let version = 0;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Re-renders the caller whenever another theme is applied. */
export const useThemeVersion = () => useSyncExternalStore(subscribe, () => version);

function applyTheme(name: string, t: Theme) {
  theme.name = name;
  Object.assign(theme.colors, t.colors);
  theme.bgPattern = t.bgPattern;
  theme.bgEffectColor = t.bgEffectColor;
  rebuilders.forEach((rebuild) => rebuild());
  version++;
  listeners.forEach((listener) => listener());
}

export async function loadCustomThemes(): Promise<Record<string, Theme>> {
  try {
    const raw = await AsyncStorage.getItem(CUSTOM_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** Apply the theme chosen last time. Call before the first render. */
export async function restoreTheme() {
  const name = await AsyncStorage.getItem(SELECTED_KEY);
  if (!name || name === theme.name) return;
  const saved = THEMES[name] ?? (await loadCustomThemes())[name];
  if (saved) applyTheme(name, saved);
}

export async function selectTheme(name: string, t: Theme) {
  applyTheme(name, t);
  await AsyncStorage.setItem(SELECTED_KEY, name);
}

/**
 * Save a custom theme and switch to it. `replacing` is the name it had before, when it's being
 * renamed. Built-in names are taken, and there's room for MAX_CUSTOM_THEMES.
 */
export async function saveCustomTheme(name: string, colors: ThemeColors, replacing?: string): Promise<'ok' | 'builtin' | 'limit'> {
  if (THEMES[name]) return 'builtin';
  const custom = await loadCustomThemes();
  if (replacing && replacing !== name) delete custom[replacing];
  if (!custom[name] && Object.keys(custom).length >= MAX_CUSTOM_THEMES) return 'limit';
  custom[name] = { colors: { ...colors } };
  await AsyncStorage.setItem(CUSTOM_KEY, JSON.stringify(custom));
  await selectTheme(name, custom[name]);
  return 'ok';
}

/** Delete a custom theme. If it's in use, the app goes back to the default theme. */
export async function deleteCustomTheme(name: string) {
  const custom = await loadCustomThemes();
  delete custom[name];
  await AsyncStorage.setItem(CUSTOM_KEY, JSON.stringify(custom));
  if (theme.name === name) await selectTheme(DEFAULT_THEME_NAME, THEMES[DEFAULT_THEME_NAME]);
}

export const isHexColor = (value: string) => /^#[0-9a-f]{6}$/i.test(value);

/** Whether a background is light enough to need dark text on it (the status bar's, say). */
export function isLightColor(hex: string) {
  if (!isHexColor(hex)) return false;
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 150;
}
