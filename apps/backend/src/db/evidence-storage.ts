import { performance } from 'node:perf_hooks';
import { EvidenceError, IncompleteEvidenceListingError, type EvidencePolicy } from './evidence-catalogue';

export interface EvidenceObject {
  bytes: Buffer; version: string; sha256: string; contentType: string;
  token: string | undefined;
  encryption: string | undefined; keyId: string | undefined;
  retentionMode: string | undefined; retainUntil: string | undefined;
}
export interface ObjectVersion { key: string; version: string; deleted: boolean }
export interface VersionPage { versions: ObjectVersion[]; truncated: boolean; keyMarker?: string; versionMarker?: string }
export interface KeyPage { keys: string[]; truncated: boolean; token?: string }
/** Ops-only port. It is never installed in the application's ObjectStorage module. */
export interface EvidenceStorage {
  readonly bucket: string;
  readonly prefix: string;
  get(key: string, version: string | undefined, limit: number, budget: EvidenceBudget): Promise<EvidenceObject | undefined>;
  versions(key: string, cursor: { keyMarker?: string; versionMarker?: string }, budget: EvidenceBudget): Promise<VersionPage>;
  keys(token: string | undefined, budget: EvidenceBudget): Promise<KeyPage>;
  put(key: string, bytes: Buffer, contentType: string, token: string, policy: EvidencePolicy, budget: EvidenceBudget): Promise<void>;
}
export interface EvidenceLimits { pages: number; versions: number; references: number; bytes: number; requestMs: number; deadlineMs: number }
export const DEFAULT_EVIDENCE_LIMITS: Readonly<EvidenceLimits> = Object.freeze({ pages: 1000, versions: 10_000, references: 10_000, bytes: 1024 ** 3, requestMs: 30_000, deadlineMs: 900_000 });
export class EvidenceBudget {
  readonly limits: EvidenceLimits;
  readonly started: number;
  pages = 0; examinedVersions = 0; readBytes = 0; writtenBytes = 0;
  constructor(limits: Partial<EvidenceLimits> = {}, readonly now: () => number = performance.now.bind(performance)) {
    this.limits = { ...DEFAULT_EVIDENCE_LIMITS, ...limits }; this.started = now();
    for (const [name, max] of Object.entries(DEFAULT_EVIDENCE_LIMITS)) {
      const value = this.limits[name as keyof EvidenceLimits];
      if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new EvidenceError('limit');
    }
  }
  check(listing = false): void { if (this.now() - this.started >= this.limits.deadlineMs) throw listing ? new IncompleteEvidenceListingError('timeout') : new EvidenceError('limit'); }
  remainingMs(): number {
    this.check(); const remaining = Math.floor(Math.min(this.limits.requestMs, this.limits.deadlineMs - (this.now() - this.started)));
    if (remaining < 1) throw new EvidenceError('limit');
    return remaining;
  }
  page(): void { this.check(true); if (++this.pages > this.limits.pages) throw new IncompleteEvidenceListingError('page-limit'); }
  version(): void { this.check(true); if (++this.examinedVersions > this.limits.versions) throw new EvidenceError('limit'); }
  read(bytes: number): void { this.readBytes += bytes; this.checkBytes(); }
  written(bytes: number): void { this.writtenBytes += bytes; this.checkBytes(); }
  private checkBytes(): void { this.check(); if (this.readBytes + this.writtenBytes > this.limits.bytes) throw new EvidenceError('limit'); }
}

export async function listVersions(store: EvidenceStorage, key: string, budget: EvidenceBudget): Promise<ObjectVersion[]> {
  const result: ObjectVersion[] = []; const cursors = new Set<string>();
  let cursor: { keyMarker?: string; versionMarker?: string } = {};
  for (;;) {
    budget.page();
    const page = await store.versions(key, cursor, budget);
    for (const version of page.versions) { budget.version(); if (version.key === key) result.push(version); }
    if (!page.truncated) return result;
    if (budget.pages >= budget.limits.pages) throw new IncompleteEvidenceListingError('page-limit');
    if (typeof page.keyMarker !== 'string' || !page.keyMarker || typeof page.versionMarker !== 'string' || !page.versionMarker) throw new IncompleteEvidenceListingError('cursor');
    // Literal "null" is a legitimate marker, unlike a missing marker.
    const next = JSON.stringify([page.keyMarker, page.versionMarker]);
    if (cursors.has(next)) throw new IncompleteEvidenceListingError('no-progress');
    cursors.add(next); cursor = { keyMarker: page.keyMarker, versionMarker: page.versionMarker };
  }
}
export async function listKeys(store: EvidenceStorage, budget: EvidenceBudget): Promise<string[]> {
  const keys = new Set<string>(); const cursors = new Set<string>(); let token: string | undefined;
  for (;;) {
    budget.page(); const page = await store.keys(token, budget);
    for (const key of page.keys) { budget.version(); keys.add(key); }
    if (!page.truncated) return [...keys].sort();
    if (budget.pages >= budget.limits.pages) throw new IncompleteEvidenceListingError('page-limit');
    if (!page.token) throw new IncompleteEvidenceListingError('cursor');
    if (cursors.has(page.token)) throw new IncompleteEvidenceListingError('no-progress');
    cursors.add(page.token); token = page.token;
  }
}
export function verifyPolicy(object: EvidenceObject, policy: EvidencePolicy, budget: EvidenceBudget): void {
  budget.check();
  // These headers come from the SAME exact-version GET as the verified bytes, not another current-object lookup.
  if (object.version === 'null' || object.encryption !== policy.encryption || (object.keyId ?? null) !== policy.keyId || object.retentionMode !== policy.mode || !object.retainUntil || Date.parse(object.retainUntil) < Date.parse(policy.retainUntil) || Date.parse(object.retainUntil) <= Date.now() || !Number.isFinite(Date.parse(object.retainUntil))) throw new EvidenceError('policy');
}
