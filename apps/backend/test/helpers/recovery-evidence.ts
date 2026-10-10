import type { S3ObjectStorage } from '../../src/object-storage/s3-object-storage';

export interface PinnedPdf { key: string; version: string; sha256: string; bytes: number }

/** Test-only rehearsal acceptance; reads the production storage adapter's bounded, exact-version response. */
export async function verifyPinnedPdf(storage: S3ObjectStorage, pdf: PinnedPdf) {
  const fetched = await storage.getObject(pdf.key, { version: pdf.version, maxBytes: pdf.bytes });
  if (!fetched) throw new Error('Required pinned PDF version is unavailable; application recovery incomplete.');
  if (fetched.version !== pdf.version || fetched.sha256 !== pdf.sha256 || fetched.sizeBytes !== pdf.bytes) {
    throw new Error('Required pinned PDF bytes do not match restored evidence; application recovery incomplete.');
  }
  return fetched;
}
