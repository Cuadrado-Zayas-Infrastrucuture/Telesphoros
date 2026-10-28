import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyTheme, readThemePreference, themeFor, writeThemePreference } from './theme';

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('theme preference', () => {
  it('follows the device until something else is chosen, and ignores a value it does not know', () => {
    expect(readThemePreference()).toBe('system');
    window.localStorage.setItem('telesphoros.theme', 'sepia');
    expect(readThemePreference()).toBe('system');
  });

  it('stores only light or dark, and forgets the choice when set back to the device', () => {
    writeThemePreference('dark');
    expect(readThemePreference()).toBe('dark');
    expect(window.localStorage.getItem('telesphoros.theme')).toBe('dark');
    writeThemePreference('system');
    expect(window.localStorage.getItem('telesphoros.theme')).toBeNull();
  });

  it('still works when browser storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(readThemePreference()).toBe('system');
    expect(() => writeThemePreference('dark')).not.toThrow();
  });
});

describe('themeFor', () => {
  it('keeps the public landing page light whatever the preference', () => {
    expect(themeFor('/', 'dark', true)).toBe('light');
  });

  it('follows the device for "system" and the choice otherwise', () => {
    expect(themeFor('/settings', 'system', true)).toBe('dark');
    expect(themeFor('/settings', 'system', false)).toBe('light');
    expect(themeFor('/reports', 'dark', false)).toBe('dark');
    expect(themeFor('/reports', 'light', true)).toBe('light');
  });
});

describe('applyTheme', () => {
  it('marks the page dark, and removes the mark for light', () => {
    const root = document.createElement('html');
    applyTheme('dark', root);
    expect(root.dataset.theme).toBe('dark');
    applyTheme('light', root);
    expect(root.hasAttribute('data-theme')).toBe(false);
  });
});
