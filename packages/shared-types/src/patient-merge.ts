import { z } from 'zod';
import { listOrderSchema, paginationQuerySchema } from './pagination';

/**
 * Possible duplicates and the merge of two patient records (M2.1c-2).
 *
 * A merge never rewrites a record: it records, with two people's names, that one patient is an alias of another, and reads resolve the pair as
 * one group. Nothing below carries an identifier value, a digest, or the name of a person.
 */

export const MERGE_KINDS = ['merge', 'unmerge'] as const;
export const MERGE_REASON_CODES = ['shared-identifier', 'entered-twice', 'merged-by-mistake'] as const;
const MERGE_REASONS = ['shared-identifier', 'entered-twice'] as const;
const UNMERGE_REASONS = ['merged-by-mistake'] as const;

/**
 * `POST /patient-merges`. `merge`: the source patient becomes an alias of the target. `unmerge`: ends the merge of this same source into this
 * same target. The reason must go with the kind.
 */
export const patientMergeCreateSchema = z
  .strictObject({
    kind: z.enum(MERGE_KINDS),
    sourcePatientId: z.uuid(),
    targetPatientId: z.uuid(),
    reasonCode: z.enum(MERGE_REASON_CODES),
  })
  .refine((body) => body.sourcePatientId !== body.targetPatientId, { message: 'A patient cannot be merged into itself.', path: ['targetPatientId'] })
  .refine((body) => ((body.kind === 'merge' ? MERGE_REASONS : UNMERGE_REASONS) as readonly string[]).includes(body.reasonCode), {
    message: 'That reason does not go with that kind.',
    path: ['reasonCode'],
  });
export type PatientMergeCreate = z.infer<typeof patientMergeCreateSchema>;

/** `POST /patient-merges/:id/decision`. */
export const patientMergeDecisionCreateSchema = z.strictObject({ decision: z.enum(['approved', 'declined']) });
export type PatientMergeDecisionCreate = z.infer<typeof patientMergeDecisionCreateSchema>;

/** A proposal and where it stands. */
export const patientMergeDtoSchema = z.strictObject({
  id: z.uuid(),
  kind: z.enum(MERGE_KINDS),
  sourcePatientId: z.uuid(),
  targetPatientId: z.uuid(),
  reasonCode: z.enum(MERGE_REASON_CODES),
  proposedAt: z.string(),
  status: z.enum(['pending', 'approved', 'declined']),
  decidedAt: z.string().nullable(),
});
export type PatientMergeDto = z.infer<typeof patientMergeDtoSchema>;

/** `GET /patient-merges` filter. */
export const patientMergeListQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(['pending', 'approved', 'declined']).optional(),
});
export type PatientMergeListQuery = z.infer<typeof patientMergeListQuerySchema>;

/** One possible duplicate: two patients whose identifiers collided under the same assigning authority. The number itself is never shown. */
export const duplicateCandidateDtoSchema = z.strictObject({
  patientId: z.uuid(),
  patientLabel: z.string(),
  otherPatientId: z.uuid(),
  otherPatientLabel: z.string(),
  system: z.string(),
  flaggedAt: z.string(),
});
export type DuplicateCandidateDto = z.infer<typeof duplicateCandidateDtoSchema>;

/** `GET /patients`: pagination plus whether merged-away patients are listed (default: no). Query strings arrive as text. */
export const patientListQuerySchema = paginationQuerySchema.extend({
  includeMerged: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  order: listOrderSchema,
});
export type PatientListQuery = z.infer<typeof patientListQuerySchema>;
