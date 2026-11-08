// Check coverage of an existing verification record; this does not rerun cosign or authenticate the file.
//   node fence-image-record.mjs RECORD IMAGE                      a SIGNATURE record covering IMAGE (FENCE-OPEN)
//   node fence-image-record.mjs RECORD IMAGE --allow-break-glass  a signature record, or a break-glass record with a written reason (ASSESSMENT-ON)
import { readFileSync } from 'node:fs';
import { validReason } from '../verify-image.mjs';
import { isMain } from '../is-main.mjs';

const STAGING_IMAGE = /^([0-9]{12})\.dkr\.ecr\.us-east-2\.amazonaws\.com\/telesphoros-staging-api@sha256:[0-9a-f]{64}$/;
export function coversFenceImage(record, image) {
  const match = STAGING_IMAGE.exec(image ?? '');
  const key = /^arn:aws:kms:us-east-2:([0-9]{12}):key\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.exec(record?.keyArn ?? '');
  return Boolean(match && key && key[1] === match[1] && record?.format === 1 && record.environment === 'staging' && record.method === 'signature' &&
    record.keyAlias === 'alias/telesphoros-staging-image-signing' &&
    /^v3\.\d+\.\d+$/.test(record.cosignVersion ?? '') && typeof record.recordedAt === 'string' && Number.isFinite(Date.parse(record.recordedAt)) &&
    Array.isArray(record.images) && record.images.length > 0 && record.images.every((value) => value === image));
}
/**
 * Switching the synthetic assessment on accepts what the medication fence does, and also a break-glass record: an unsigned image the founder
 * recorded on purpose, naming this exact digest and a written reason (verify-image.mjs --unsigned-break-glass; never for production, which the
 * recorder itself refuses). The medication fence keeps requiring a signature.
 */
export function coversAssessmentImage(record, image) {
  if (coversFenceImage(record, image)) return true;
  return Boolean(STAGING_IMAGE.test(image ?? '') && record?.format === 1 && record.environment === 'staging' && record.method === 'break-glass' &&
    validReason(record.reason) && typeof record.recordedAt === 'string' && Number.isFinite(Date.parse(record.recordedAt)) &&
    Array.isArray(record.images) && record.images.length > 0 && record.images.every((value) => value === image));
}
if (isMain(import.meta.url)) {
  const allowBreakGlass = process.argv[4] === '--allow-break-glass';
  let ok = false;
  try {
    const wellFormed = process.argv.length === 4 || (process.argv.length === 5 && allowBreakGlass);
    ok = wellFormed && (allowBreakGlass ? coversAssessmentImage : coversFenceImage)(JSON.parse(readFileSync(process.argv[2], 'utf8')), process.argv[3]);
  } catch { /* fixed refusal */ }
  if (!ok) {
    console.error(allowBreakGlass ? 'REFUSED: switching on needs a verification record covering the running staging image: a signature, or a break-glass record with a written reason'
      : 'REFUSED: opening needs a signature-verification record covering the running staging image');
    process.exitCode = 1;
  }
}
