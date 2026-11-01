import { createContext, type ReactNode, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { preferenceStorage } from '@/lib/storageConsent';
import { applyTheme, deviceQuery, readThemePreference, themeFor, type ThemePreference, writeThemePreference } from '@/lib/theme';

interface ThemeContextValue {
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
  /** Whether the device is set to dark, followed live for the "system" preference. */
  deviceDark: boolean;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/** Holds the theme preference and applies it to the page for the current route (the landing page always stays light). */
export function ThemeProvider({ pathname, children }: { pathname: string; children: ReactNode }) {
  const [preference, setPreferenceState] = useState(readThemePreference);
  const [deviceDark, setDeviceDark] = useState(() => deviceQuery()?.matches ?? false);

  useEffect(() => {
    const query = deviceQuery();
    if (!query) return;
    const update = (event: MediaQueryListEvent) => setDeviceDark(event.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  useEffect(() => preferenceStorage.subscribe(() => setPreferenceState(readThemePreference())), []);

  // Before paint, so a route change or a new choice never shows a frame in the old theme.
  useLayoutEffect(() => applyTheme(themeFor(pathname, preference, deviceDark)), [pathname, preference, deviceDark]);

  const setPreference = useCallback((next: ThemePreference) => {
    writeThemePreference(next);
    setPreferenceState(next);
  }, []);

  const value = useMemo(() => ({ preference, setPreference, deviceDark }), [preference, setPreference, deviceDark]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used inside <ThemeProvider>');
  return value;
}
