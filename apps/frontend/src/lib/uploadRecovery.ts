import { recoveryScopeSchema } from '@telesphoros/shared-types';
import { z } from 'zod';
import { attemptSchema, declarationSchema, fileFingerprintSchema, type FileFingerprint, type OwnedProgress } from './uploadProgress';

/** One tab, one verified caller/tenant, at most one hour from the initial save. No bytes, token, signed link, raw identity or file name. */
const KEY = 'telesphoros.upload-recovery.v2';
const LEGACY_KEY = 'telesphoros.upload-recovery.v1';
export const RECOVERY_LIFETIME_MS = 60 * 60 * 1000;
/** Records saved before the file name was dropped carry `name`, which this strict schema refuses: they are removed on read. */
const entrySchema = z.strictObject({
  v: z.literal(2), scope: recoveryScopeSchema,
  requestId: z.uuid(), reportId: z.uuid(),
  declaration: declarationSchema.optional(), attempt: attemptSchema.optional(),
  file: fileFingerprintSchema, savedAt: z.iso.datetime(),
});
export type RecoveryEntry = z.infer<typeof entrySchema>;
/** Created only after /me succeeds. A null scope guards in-flight work without enabling persistence. */
export interface RecoverySession { readonly scope: string | null }
const active = new WeakSet<RecoverySession>();
interface Binding { session: RecoverySession; requestId?: string; savedAt?: string }
const bindings = new WeakMap<object, Binding>();
let expiryTimer: ReturnType<typeof setTimeout> | undefined;

function store(): Storage | undefined {
  try { return typeof window === 'undefined' ? undefined : window.sessionStorage; } catch { return undefined; }
}
const fresh = (savedAt: string) => {
  const age = Date.now() - Date.parse(savedAt);
  return Number.isFinite(age) && age >= 0 && age < RECOVERY_LIFETIME_MS;
};
/** Expire stored metadata even after navigation; compare identity so an old timer cannot delete a newer upload. */
function armExpiry(entry: RecoveryEntry): void {
  if (expiryTimer !== undefined) clearTimeout(expiryTimer);
  expiryTimer = setTimeout(() => {
    expiryTimer = undefined;
    try {
      const s = store();
      const parsed = entrySchema.safeParse(JSON.parse(s?.getItem(KEY) ?? 'null'));
      if (parsed.success && parsed.data.scope === entry.scope && parsed.data.requestId === entry.requestId
        && parsed.data.reportId === entry.reportId && parsed.data.savedAt === entry.savedAt && !fresh(parsed.data.savedAt)) s?.removeItem(KEY);
    } catch { /* blocked storage */ }
  }, Math.max(0, Date.parse(entry.savedAt) + RECOVERY_LIFETIME_MS - Date.now()));
}
export function recoverySessionActive(session: RecoverySession | null | undefined): session is RecoverySession {
  return !!session && active.has(session);
}
/** Discard foreign, stale and unbound metadata before the authenticated route is mounted. */
export function startRecoverySession(scope?: string): RecoverySession {
  const session = Object.freeze({ scope: scope === undefined ? null : recoveryScopeSchema.parse(scope) });
  active.add(session);
  if (session.scope === null) { clearRecovery(); return session; }
  try { store()?.removeItem(LEGACY_KEY); } catch { /* blocked storage */ }
  readRecovery(session);
  return session;
}
/** A 401/expiry retires in-flight work but leaves the scoped record for the same person to recover after sign-in. */
export function endRecoverySession(session: RecoverySession | null): void {
  if (session) active.delete(session);
}
export function readRecovery(session?: RecoverySession | null): RecoveryEntry | undefined {
  if (!recoverySessionActive(session) || session.scope === null) return undefined;
  const s = store();
  if (!s) return undefined;
  try {
    const raw = s.getItem(KEY);
    if (raw === null) return undefined;
    const parsed = entrySchema.safeParse(JSON.parse(raw));
    if (parsed.success && parsed.data.scope === session.scope && fresh(parsed.data.savedAt)) { armExpiry(parsed.data); return parsed.data; }
    s.removeItem(KEY);
  } catch { try { s.removeItem(KEY); } catch { /* blocked storage */ } }
  return undefined;
}
/** Explicit sign-out clears both versions; retiring an expired session alone does not. */
export function clearRecovery(): void {
  if (expiryTimer !== undefined) clearTimeout(expiryTimer);
  expiryTimer = undefined;
  try { const s = store(); s?.removeItem(KEY); s?.removeItem(LEGACY_KEY); } catch { /* blocked storage */ }
}
export function bindRecovery(progress: object, session: RecoverySession, entry?: RecoveryEntry): void {
  if (!recoverySessionActive(session)) throw new Error('Recovery session ended');
  const previous = bindings.get(progress);
  if (previous && previous.session !== session) throw new Error('Recovery session changed');
  if (entry && (entry.scope !== session.scope || !fresh(entry.savedAt))) throw new Error('Recovery record expired or changed');
  if (!previous) bindings.set(progress, { session, ...(entry ? { requestId: entry.requestId, savedAt: entry.savedAt } : {}) });
}
export function uploadSessionCurrent(progress: object): boolean {
  const binding = bindings.get(progress);
  return !binding || recoverySessionActive(binding.session);
}
/** Late callbacks from a retired sign-in must not write or clear the current person's record. */
export function forgetUpload(progress: object & { requestId?: string; reportId?: string }): void {
  const binding = bindings.get(progress);
  if (!binding || !recoverySessionActive(binding.session)) return;
  const entry = readRecovery(binding.session);
  if (entry && entry.requestId === progress.requestId && entry.reportId === progress.reportId) clearRecovery();
}
export function rememberUpload(progress: OwnedProgress & { requestId?: string; reportId?: string }): void {
  const binding = bindings.get(progress);
  if (!binding || !recoverySessionActive(binding.session) || binding.session.scope === null || !progress.requestId || !progress.reportId || !progress.facts) return;
  if (binding.requestId !== progress.requestId) {
    binding.requestId = progress.requestId;
    binding.savedAt = new Date().toISOString();
  }
  if (!binding.savedAt || !fresh(binding.savedAt)) { forgetUpload(progress); return; }
  try {
    const entry: RecoveryEntry = {
      v: 2, scope: binding.session.scope, requestId: progress.requestId, reportId: progress.reportId,
      file: { reportType: progress.facts.reportType, sizeBytes: progress.facts.sizeBytes, sha256: progress.facts.sha256 }, savedAt: binding.savedAt,
      ...(progress.declaration ? { declaration: progress.declaration } : {}), ...(progress.attempt ? { attempt: progress.attempt } : {}),
    };
    store()?.setItem(KEY, JSON.stringify(entry));
    armExpiry(entry);
  } catch { /* storage full/blocked: the upload continues without reload recovery */ }
}
export function sameFile(saved: FileFingerprint, facts: FileFingerprint): boolean {
  return saved.reportType === facts.reportType && saved.sizeBytes === facts.sizeBytes && saved.sha256 === facts.sha256;
}
