import { ownedStorageMode } from '@/lib/storageMode';

/** What the person chose in Settings. "system" follows the device's light or dark setting. */
export type ThemePreference = 'system' | 'light' | 'dark';
export type Theme = 'light' | 'dark';

export const THEME_PREFERENCES: readonly ThemePreference[] = ['system', 'light', 'dark'];
const STORAGE_KEY = 'telesphoros.theme';
const DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * The saved preference. Only this one word is stored: it is not sensitive, and keeping it lets a reload open in the chosen theme.
 * Browser storage can be missing or blocked (private windows, strict settings); the page then follows the device.
 */
export function readThemePreference(): ThemePreference {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    return THEME_PREFERENCES.includes(saved as ThemePreference) ? (saved as ThemePreference) : 'system';
  } catch {
    return 'system';
  }
}

export function writeThemePreference(preference: ThemePreference): void {
  try {
    if (preference === 'system') window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    // Not saved: the choice still applies to this tab.
  }
}

export function deviceQuery(): MediaQueryList | undefined {
  return typeof window.matchMedia === 'function' ? window.matchMedia(DARK_QUERY) : undefined;
}

/** The public landing page keeps its approved light design whatever the preference; every other page follows it. */
export function themeFor(pathname: string, preference: ThemePreference, deviceDark: boolean): Theme {
  if (pathname === '/' && !ownedStorageMode()) return 'light';
  if (preference === 'system') return deviceDark ? 'dark' : 'light';
  return preference;
}

/** The dark tokens in styles/tokens.css apply under `<html data-theme="dark">`; light is the default without it. */
export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  if (theme === 'dark') root.dataset.theme = 'dark';
  else delete root.dataset.theme;
}
