import { createHash, randomUUID } from 'node:crypto';

/** The tenant appears only as a hash: a stable per-tenant prefix (for storage policies) with no raw identifier or unsafe characters. */
export function tenantPrefix(tenantId: string): string {
  return createHash('sha256').update(tenantId).digest('hex').slice(0, 32);
}

/** Where an uploaded report file lives. Random, so a key can never be guessed from the report id. */
export function reportObjectKey(tenantId: string, reportId: string): string {
  return `reports/${tenantPrefix(tenantId)}/${reportId}/${randomUUID()}`;
}

/**
 * Where the text read from a report lives. Content-addressed and deterministic: the same text from the same report always has the
 * same key, so a retry after a failed insert writes identical bytes (an orphan is harmless), and nothing else can legitimately
 * change what is under it. Under `reports/` so the application's storage policy covers it.
 */
export function textObjectKey(tenantId: string, reportId: string, textSha256: string, popplerVersion: string): string {
  return `reports/${tenantPrefix(tenantId)}/${reportId}/text/${textSha256}-${popplerVersion}`;
}
