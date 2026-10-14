import { z } from 'zod';
import { attemptSchema, declarationSchema, fileFactsSchema, type FileFacts, type OwnedProgress } from './uploadProgress';

/**
 * Surviving a page reload (M2.2c). While an upload is in flight the browser keeps one small record in `sessionStorage` (this tab only; gone when the tab
 * closes and when the person signs out) so that after a reload it can finish or cancel the same upload instead of registering a second report.
 *
 * What it holds: the report id, the registration key, the original declaration, the last attempt state the server reported, and the file's name, size,
 * type and SHA-256. What it never holds: the file's bytes, a token, a signed link, or the patient (the patient is chosen again, and the server refuses a
 * report that belongs to someone else). Storage can be unavailable (private windows, blocked site data): every read and write is guarded and the upload
 * simply works without recovery.
 */
const KEY = 'telesphoros.upload-recovery.v1';

const entrySchema = z.strictObject({
  v: z.literal(1),
  requestId: z.uuid(),
  reportId: z.uuid(),
  declaration: declarationSchema.optional(),
  attempt: attemptSchema.optional(),
  file: fileFactsSchema,
  savedAt: z.iso.datetime(),
});
export type RecoveryEntry = z.infer<typeof entrySchema>;

function store(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.sessionStorage;
  } catch {
    return undefined;
  }
}

/** The saved upload, or undefined if there is none, it is damaged (then it is removed), or storage is unavailable. */
export function readRecovery(): RecoveryEntry | undefined {
  const s = store();
  if (!s) return undefined;
  try {
    const raw = s.getItem(KEY);
    if (raw === null) return undefined;
    const parsed = entrySchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
    s.removeItem(KEY);
  } catch {
    try { s.removeItem(KEY); } catch { /* nothing more to do */ }
  }
  return undefined;
}

export function clearRecovery(): void {
  try { store()?.removeItem(KEY); } catch { /* storage unavailable: nothing was kept */ }
}

/** Saves what is needed to continue this upload after a reload. Does nothing until the report exists and the file is known. */
export function rememberUpload(progress: OwnedProgress & { requestId?: string; reportId?: string }): void {
  const s = store();
  if (!s || !progress.requestId || !progress.reportId || !progress.facts) return;
  try {
    const entry: RecoveryEntry = {
      v: 1, requestId: progress.requestId, reportId: progress.reportId, file: progress.facts, savedAt: new Date().toISOString(),
      ...(progress.declaration ? { declaration: progress.declaration } : {}),
      ...(progress.attempt ? { attempt: progress.attempt } : {}),
    };
    s.setItem(KEY, JSON.stringify(entry));
  } catch { /* storage full or blocked: the upload continues without recovery */ }
}

/** True when the saved upload is for this very file (same type, name, size and SHA-256). */
export function sameFile(saved: FileFacts, facts: FileFacts): boolean {
  return saved.reportType === facts.reportType && saved.name === facts.name && saved.sizeBytes === facts.sizeBytes && saved.sha256 === facts.sha256;
}
