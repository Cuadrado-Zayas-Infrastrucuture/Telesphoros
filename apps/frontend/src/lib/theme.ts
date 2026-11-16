import { preferenceStorage } from '@/lib/storageConsent';
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
    const saved = preferenceStorage.read(STORAGE_KEY);
    return THEME_PREFERENCES.includes(saved as ThemePreference) ? (saved as ThemePreference) : 'system';
  } catch {
    return 'system';
  }
}

export function writeThemePreference(preference: ThemePreference): void {
  try {
    if (preference === 'system') preferenceStorage.write(STORAGE_KEY, null);
    else preferenceStorage.write(STORAGE_KEY, preference);
  } catch {
    // Not saved: the choice still applies to this tab.
  }
}

export function deviceQuery(): MediaQueryList | undefined {
  return typeof window.matchMedia === 'function' ? window.matchMedia(DARK_QUERY) : undefined;
}

/** The pages a signed-out person passes through. */
export const SIGN_IN_FLOW: readonly string[] = ['/signin', '/auth/callback', '/signed-out'];

/**
 * The sign-in flow wears the public landing's night look whatever the preference (founder decision 2026-11-16), so the step
 * from telesphoros.app to signing in does not change colour. A trailing slash is the same page.
 */
export function nightSurface(pathname: string): boolean {
  return SIGN_IN_FLOW.includes(pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname);
}

/** The public landing page keeps its approved light design and the sign-in flow its night look, whatever the preference; every other page follows it. */
export function themeFor(pathname: string, preference: ThemePreference, deviceDark: boolean): Theme {
  if (pathname === '/' && !ownedStorageMode()) return 'light';
  if (nightSurface(pathname)) return 'dark';
  if (preference === 'system') return deviceDark ? 'dark' : 'light';
  return preference;
}

/**
 * The dark tokens in styles/tokens.css apply under `<html data-theme="dark">`; light is the default without it.
 * `night` adds `data-surface="night"`, whose tokens replace the dark colours on the sign-in flow.
 */
export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement, night = false): void {
  if (theme === 'dark') root.dataset.theme = 'dark';
  else delete root.dataset.theme;
  if (night) root.dataset.surface = 'night';
  else delete root.dataset.surface;
}

/** The one way a route gets its look: used before the first render (main.tsx) and on every route change (ThemeProvider). */
export function applyRouteTheme(pathname: string, preference: ThemePreference, deviceDark: boolean, root: HTMLElement = document.documentElement): void {
  applyTheme(themeFor(pathname, preference, deviceDark), root, nightSurface(pathname));
}
