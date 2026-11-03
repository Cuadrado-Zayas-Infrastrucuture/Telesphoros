import { z } from 'zod';

export const structuredRecordCreateSchema = z.strictObject({
  patientId: z.uuid(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  objectVersion: z.string().min(1).max(1024),
  sourcePatientReference: z.string().regex(/^syn-[a-z0-9-]{1,76}$/),
  patientLinkDecisionId: z.uuid(),
});
export type StructuredRecordCreate = z.infer<typeof structuredRecordCreateSchema>;
const history = z.strictObject({
  id: z.uuid(),
  reportId: z.uuid(),
  laboratoryId: z.string(),
  seriesId: z.string(),
  laboratoryReportId: z.string(),
  revision: z.int().positive(),
  status: z.string(),
  createdAt: z.iso.datetime(),
  findingIds: z.array(z.string()).max(50),
  currentBinding: z.boolean(),
});
export const structuredRecordStateSchema = z.strictObject({
  reportId: z.uuid(),
  patientId: z.uuid(),
  record: history.nullable(),
  history: z.array(history).max(100),
  state: z.enum(['not-recorded', 'candidate-for-review', 'superseded', 'held']),
  reasons: z.array(z.string()).max(20),
  synthetic: z.literal(true),
  clinicalUse: z.literal('not-approved'),
  actionable: z.literal(false),
  independentReviewRequired: z.literal(true),
});
export type StructuredRecordState = z.infer<typeof structuredRecordStateSchema>;
