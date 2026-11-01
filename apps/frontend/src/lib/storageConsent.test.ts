import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONSENT_KEY, PREFERENCE_KEYS, PreferenceStorage } from './storageConsent';

let store: PreferenceStorage;
beforeEach(() => {
  window.localStorage.clear();
  store = new PreferenceStorage();
});
afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('optional preference storage consent', () => {
  it('does not read or write optional storage before a decision, but keeps explicit choices in this tab', () => {
    localStorage.setItem('telesphoros.theme', 'dark');
    expect(store.read('telesphoros.theme')).toBeNull();
    store.write('telesphoros.sidebar', 'collapsed');
    expect(store.read('telesphoros.sidebar')).toBe('collapsed');
    expect(localStorage.getItem('telesphoros.sidebar')).toBeNull();
    expect(store.getSnapshot().preferences).toBeNull();
  });

  it('persists current-tab choices only after acceptance and remembers that decision', () => {
    store.write('telesphoros.theme', 'dark');
    expect(store.choose(true)).toEqual({ persisted: true, cleared: true });
    expect(localStorage.getItem('telesphoros.theme')).toBe('dark');
    store.write('telesphoros.sidebar', 'collapsed');
    expect(localStorage.getItem('telesphoros.sidebar')).toBe('collapsed');
    expect(new PreferenceStorage().getSnapshot()).toEqual({ preferences: true, persisted: true });
  });

  it('withdraws only display/language persistence, preserving current-tab choices and required/unrelated data', () => {
    store.choose(true);
    for (const key of PREFERENCE_KEYS) store.write(key, 'synthetic-preference');
    localStorage.setItem('unrelated-app-setting', 'keep');
    sessionStorage.setItem('oidc.synthetic-state', 'keep');
    sessionStorage.setItem('telesphoros.upload-recovery.v2', 'synthetic-recovery');
    expect(store.choose(false)).toEqual({ persisted: true, cleared: true });
    for (const key of PREFERENCE_KEYS) expect(localStorage.getItem(key)).toBeNull();
    expect(store.read('telesphoros.theme')).toBe('synthetic-preference');
    expect(new PreferenceStorage().read('telesphoros.theme')).toBeNull();
    expect(localStorage.getItem('unrelated-app-setting')).toBe('keep');
    expect(sessionStorage.getItem('oidc.synthetic-state')).toBe('keep');
    expect(sessionStorage.getItem('telesphoros.upload-recovery.v2')).toBe('synthetic-recovery');
  });

  it.each(['{bad', '{"version":2,"preferences":true}', '{"version":1,"preferences":"true"}'])('fails closed for an invalid or obsolete decision: %s', (record) => {
    store.choose(true);
    localStorage.setItem(CONSENT_KEY, record);
    expect(store.getSnapshot().preferences).toBeNull();
    store.write('telesphoros.theme', 'light');
    expect(localStorage.getItem('telesphoros.theme')).toBeNull();
  });

  it('keeps an explicit temporary decision when storage is blocked, and reports that clearing was prevented', () => {
    const blocked = new PreferenceStorage(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(blocked.choose(false)).toEqual({ persisted: false, cleared: false });
    expect(blocked.getSnapshot()).toEqual({ preferences: false, persisted: false });
    blocked.write('telesphoros.theme', 'dark');
    expect(blocked.read('telesphoros.theme')).toBe('dark');
    expect(localStorage.getItem('telesphoros.theme')).toBeNull();
  });

  it('honors a withdrawal in another tab before subsequent preference writes', () => {
    store.choose(true);
    const changed = vi.fn();
    const stop = store.subscribe(changed);
    localStorage.setItem(CONSENT_KEY, JSON.stringify({ version: 1, preferences: false }));
    window.dispatchEvent(new StorageEvent('storage', { key: CONSENT_KEY }));
    expect(changed).toHaveBeenCalledOnce();
    store.write('telesphoros.theme', 'dark');
    expect(localStorage.getItem('telesphoros.theme')).toBeNull();
    stop();
  });

  it('invalidates an old grant when quota prevents saving the withdrawal', () => {
    store.choose(true);
    store.write('telesphoros.theme', 'dark');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    expect(store.choose(false)).toEqual({ persisted: false, cleared: true });
    expect(localStorage.getItem(CONSENT_KEY)).toBeNull();
    expect(localStorage.getItem('telesphoros.theme')).toBeNull();
    expect(new PreferenceStorage().getSnapshot().preferences).toBeNull();
  });
});
