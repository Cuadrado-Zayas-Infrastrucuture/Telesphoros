// Check coverage of an existing verification record; this does not rerun cosign or authenticate the file.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export function coversFenceImage(record, image) {
  const match = /^([0-9]{12})\.dkr\.ecr\.us-east-2\.amazonaws\.com\/telesphoros-staging-api@sha256:[0-9a-f]{64}$/.exec(image ?? '');
  return Boolean(match && record?.format === 1 && record.environment === 'staging' && record.method === 'signature' &&
    record.keyAlias === 'alias/telesphoros-staging-image-signing' &&
    new RegExp(`^arn:aws:kms:us-east-2:${match[1]}:key/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`).test(record.keyArn ?? '') &&
    /^v3\.\d+\.\d+$/.test(record.cosignVersion ?? '') && typeof record.recordedAt === 'string' && Number.isFinite(Date.parse(record.recordedAt)) &&
    Array.isArray(record.images) && record.images.length > 0 && record.images.every((value) => value === image));
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let ok = false;
  try { ok = process.argv.length === 4 && coversFenceImage(JSON.parse(readFileSync(process.argv[2], 'utf8')), process.argv[3]); } catch { /* fixed refusal */ }
  if (!ok) { console.error('REFUSED: opening needs a signature-verification record covering the running staging image'); process.exitCode = 1; }
}
