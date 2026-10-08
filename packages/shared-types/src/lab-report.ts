import { z } from 'zod';

/**
 * The lab-report pipeline's public shapes (slice 5B-3.2). The pipeline is a SYNTHETIC, NON-PRODUCTION integration: the reader and the
 * engine are test-only and nothing here is approved for clinical use. These DTOs never carry report text, span text, a note body,
 * a storage key, or the identity of the person who created a record.
 */

/** Written inside every stored evaluation and returned with it, so the claim cannot be separated from the result. */
export const PIPELINE_SCOPE = 'synthetic-test-only/1';
export const CLINICAL_USE = 'not-approved';

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const timestamp = z.string().min(1);

/** A decision about a capture, as the API shows it. The note is a digest of a stored note, never its text. */
export const acceptanceDtoSchema = z.strictObject({
  id: z.uuid(),
  captureId: z.uuid(),
  decision: z.enum(['accepted', 'rejected']),
  textSha256: sha256,
  popplerVersion: z.string(),
  note: z.strictObject({ id: z.uuid(), bodySha256: sha256 }).nullable(),
  createdAt: timestamp,
});
export type AcceptanceDto = z.infer<typeof acceptanceDtoSchema>;

/** One text read from one stored PDF. */
export const captureDtoSchema = z.strictObject({
  id: z.uuid(),
  reportId: z.uuid(),
  pdfSha256: sha256,
  textSha256: sha256,
  textScalars: z.number().int().min(0),
  popplerVersion: z.string(),
  /** `fake` stands in for real extraction (recorded text for known test files). */
  runner: z.enum(['fake', 'poppler']),
  createdAt: timestamp,
  /** The latest decision about this capture (a later one supersedes an earlier one), or null if nobody has decided. */
  latestDecision: acceptanceDtoSchema.nullable(),
});
export type CaptureDto = z.infer<typeof captureDtoSchema>;

export const fileLinkDtoSchema = z.strictObject({
  /** A bearer credential for ONE version of ONE file, valid until `expiresAt`. Never log it. */
  url: z.string().min(1),
  expiresAt: z.iso.datetime(),
});
export type FileLinkDto = z.infer<typeof fileLinkDtoSchema>;

export const MAX_NOTE_LENGTH = 1000;

/** `POST /captures/:id/decision`. The text hash and Poppler version are copied from the capture, never taken from the body. */
export const decisionCreateSchema = z.strictObject({
  decision: z.enum(['accepted', 'rejected']),
  note: z.string().trim().min(1).max(MAX_NOTE_LENGTH).optional(),
});
export type DecisionCreate = z.infer<typeof decisionCreateSchema>;
