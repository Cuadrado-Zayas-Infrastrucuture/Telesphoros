import { z } from 'zod';
import { LINK_REJECT_BASIS_CODES, LINK_VERIFY_BASIS_CODES, patientLinkDtoSchema } from './patient-identity';
import { syntheticPgxLabReportSchema } from './synthetic-pgx';

/** Owned-local inspection of source evidence. Never a generated prescribing assessment. */
export const structuredPreviewSchema = z.strictObject({
  reportId: z.uuid(),
  patientId: z.uuid(),
  patientLabel: z.string(),
  source: z.strictObject({ sha256: z.string().regex(/^[a-f0-9]{64}$/), objectVersion: z.string().min(1).max(1024) }),
  laboratoryReport: syntheticPgxLabReportSchema,
  patientLink: patientLinkDtoSchema,
  canReview: z.boolean(),
  lineage: z.literal('not-reconciled'),
  synthetic: z.literal(true),
  clinicalUse: z.literal('not-approved'),
  actionable: z.literal(false),
});
export type StructuredPreview = z.infer<typeof structuredPreviewSchema>;

const binding = {
  patientId: z.uuid(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  objectVersion: z.string().min(1).max(1024),
  sourcePatientReference: z.string().regex(/^syn-[a-z0-9-]{1,76}$/),
};
export const structuredPatientLinkSchema = z.discriminatedUnion('decision', [
  z.strictObject({ ...binding, decision: z.literal('verified'), basisCode: z.enum(LINK_VERIFY_BASIS_CODES) }),
  z.strictObject({ ...binding, decision: z.literal('rejected'), basisCode: z.enum(LINK_REJECT_BASIS_CODES) }),
]);
export type StructuredPatientLink = z.infer<typeof structuredPatientLinkSchema>;
