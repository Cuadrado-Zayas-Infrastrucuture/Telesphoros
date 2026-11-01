import { z } from 'zod';

export const CONSENT_KEY = 'telesphoros.storage-consent.v1';
export const PREFERENCE_KEYS = ['telesphoros.theme', 'telesphoros.sidebar', 'telesphoros.landing.language'] as const;
type PreferenceKey = (typeof PREFERENCE_KEYS)[number];
const savedSchema = z.object({ version: z.literal(1), preferences: z.boolean() });
export interface ConsentSnapshot {
  readonly preferences: boolean | null;
  readonly persisted: boolean;
}
const UNKNOWN: ConsentSnapshot = { preferences: null, persisted: false };
const ALLOWED: ConsentSnapshot = { preferences: true, persisted: true };
const NECESSARY: ConsentSnapshot = { preferences: false, persisted: true };
const TEMP_ALLOWED: ConsentSnapshot = { preferences: true, persisted: false };
const TEMP_NECESSARY: ConsentSnapshot = { preferences: false, persisted: false };

/** Only the three display preferences are optional. Auth, recovery and application events never pass through this store. */
export class PreferenceStorage {
  private session = new Map<PreferenceKey, string | null>();
  private fallback = UNKNOWN;
  private memoryOnly = false;
  private lastRaw: string | null | undefined;
  private listeners = new Set<() => void>();

  constructor(private readonly storage: () => Storage = () => window.localStorage) {}

  getServerSnapshot = (): ConsentSnapshot => UNKNOWN;
  getSnapshot = (): ConsentSnapshot => {
    if (this.memoryOnly) return this.fallback;
    let raw: string | null;
    try {
      raw = this.storage().getItem(CONSENT_KEY);
    } catch {
      return this.fallback.preferences === null ? UNKNOWN : this.fallback.preferences ? TEMP_ALLOWED : TEMP_NECESSARY;
    }
    if (raw === null && raw !== this.lastRaw) this.session.clear();
    this.lastRaw = raw;
    try {
      const parsed = savedSchema.safeParse(JSON.parse(raw ?? 'null'));
      this.fallback = parsed.success ? (parsed.data.preferences ? ALLOWED : NECESSARY) : UNKNOWN;
    } catch {
      this.fallback = UNKNOWN;
    }
    return this.fallback;
  };

  read(key: PreferenceKey): string | null {
    const consent = this.getSnapshot();
    if (this.session.has(key)) return this.session.get(key) ?? null;
    if (consent.preferences !== true || !consent.persisted) return null;
    try {
      return this.storage().getItem(key);
    } catch {
      return null;
    }
  }

  write(key: PreferenceKey, value: string | null): void {
    const consent = this.getSnapshot();
    this.session.set(key, value);
    if (consent.preferences !== true || !consent.persisted) return;
    this.persistPreference(key, value);
  }

  private persistPreference(key: PreferenceKey, value: string | null): void {
    try {
      if (value === null) this.storage().removeItem(key);
      else this.storage().setItem(key, value);
    } catch {
      // The current-tab choice still works when storage is unavailable or full.
    }
  }

  choose(preferences: boolean): { persisted: boolean; cleared: boolean } {
    const previous = this.getSnapshot();
    if (!preferences && previous.preferences === true) {
      for (const key of PREFERENCE_KEYS) {
        if (this.session.has(key)) continue;
        try {
          this.session.set(key, this.storage().getItem(key));
        } catch {
          /* current UI state remains usable */
        }
      }
    }
    const record = JSON.stringify({ version: 1, preferences });
    let persisted = false;
    let cleared = true;
    try {
      this.storage().setItem(CONSENT_KEY, record);
      this.lastRaw = record;
      persisted = true;
    } catch {
      // Invalidate a previous grant if a withdrawal cannot be saved (e.g. quota exhausted).
      if (!preferences) {
        try {
          this.storage().removeItem(CONSENT_KEY);
        } catch {
          cleared = false;
        }
      }
    }
    this.memoryOnly = !persisted;
    this.fallback = persisted ? (preferences ? ALLOWED : NECESSARY) : preferences ? TEMP_ALLOWED : TEMP_NECESSARY;
    if (!preferences) {
      for (const key of PREFERENCE_KEYS) {
        try {
          this.storage().removeItem(key);
        } catch {
          cleared = false;
        }
      }
    } else if (persisted) {
      for (const [key, value] of this.session) this.persistPreference(key, value);
    }
    this.listeners.forEach((listener) => listener());
    return { persisted, cleared };
  }

  private onStorage = (event: StorageEvent) => {
    if (event.key !== CONSENT_KEY && event.key !== null) return;
    this.memoryOnly = false;
    if (event.key === null) this.session.clear();
    this.listeners.forEach((listener) => listener());
  };

  subscribe = (listener: () => void) => {
    if (this.listeners.size === 0 && typeof window !== 'undefined') window.addEventListener('storage', this.onStorage);
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0 && typeof window !== 'undefined') window.removeEventListener('storage', this.onStorage);
    };
  };
}

export const preferenceStorage = new PreferenceStorage();
