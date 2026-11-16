import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { preferenceStorage } from './storageConsent';
import { applyRouteTheme, applyTheme, nightSurface, readThemePreference, themeFor, writeThemePreference } from './theme';

beforeEach(() => preferenceStorage.choose(true));

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

describe('the sign-in flow', () => {
  it('is the night surface on its three pages, with or without a trailing slash, and nowhere else', () => {
    for (const path of ['/signin', '/signin/', '/auth/callback', '/signed-out']) expect(nightSurface(path)).toBe(true);
    for (const path of ['/', '/workspace', '/settings', '/signin/extra']) expect(nightSurface(path)).toBe(false);
  });

  it('is dark whatever the preference or the device', () => {
    expect(themeFor('/signin', 'light', false)).toBe('dark');
    expect(themeFor('/signed-out', 'system', false)).toBe('dark');
    expect(themeFor('/auth/callback', 'dark', true)).toBe('dark');
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

  it('marks the night surface, and removes the mark on the next page', () => {
    const root = document.createElement('html');
    applyTheme('dark', root, true);
    expect(root.dataset.theme).toBe('dark');
    expect(root.dataset.surface).toBe('night');
    applyTheme('dark', root);
    expect(root.dataset.theme).toBe('dark');
    expect(root.hasAttribute('data-surface')).toBe(false);
  });

  it('gives a route its whole look in one call: night on sign-in even when light is chosen, plain light elsewhere', () => {
    const root = document.createElement('html');
    applyRouteTheme('/signin', 'light', false, root);
    expect(root.dataset.theme).toBe('dark');
    expect(root.dataset.surface).toBe('night');
    applyRouteTheme('/settings', 'light', false, root);
    expect(root.hasAttribute('data-theme')).toBe(false);
    expect(root.hasAttribute('data-surface')).toBe(false);
  });
});
