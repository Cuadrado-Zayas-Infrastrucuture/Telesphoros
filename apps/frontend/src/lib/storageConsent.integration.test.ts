import { afterEach, expect, it } from 'vitest';
import { readThemePreference, writeThemePreference } from './theme';

afterEach(() => window.localStorage.clear());

it('ignores saved optional preferences before consent and keeps new choices in the current session', () => {
  window.localStorage.clear();
  window.localStorage.setItem('telesphoros.theme', 'dark');
  expect(readThemePreference()).toBe('system');
  window.localStorage.removeItem('telesphoros.theme');
  writeThemePreference('light');
  expect(window.localStorage.getItem('telesphoros.theme')).toBeNull();
  expect(readThemePreference()).toBe('light');
});
