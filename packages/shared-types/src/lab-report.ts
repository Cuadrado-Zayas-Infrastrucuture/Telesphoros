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

/** `POST /reports/:id/evaluations`. Names the capture and the exact decision the caller relies on; nothing else is taken from the body. */
export const evaluationCreateSchema = z.strictObject({ captureId: z.uuid(), acceptanceId: z.uuid() });
export type EvaluationCreate = z.infer<typeof evaluationCreateSchema>;

const evaluationResultDtoSchema = z.strictObject({
  drug: z.string(),
  genes: z.array(z.string()),
  outcome: z.string(),
  reasonCode: z.string().nullable(),
  strength: z.string().nullable(),
  /** The guideline cell this wording came from (guideline id and version, locator, verification). Absent for outcomes with no citation. */
  citation: z.looseObject({}).nullable(),
  recommendationText: z.string().nullable(),
  implication: z.string().nullable(),
  geneEvidence: z.array(z.looseObject({})).nullable(),
});

const evaluationGeneStateDtoSchema = z.strictObject({
  gene: z.string(),
  state: z.string(),
  phenotype: z.string().nullable(),
  diplotype: z.string().nullable(),
  activityScore: z.string().nullable(),
  reasonCode: z.string().nullable(),
});

/**
 * A stored evaluation. It is a SYNTHETIC, NON-PRODUCTION result (`clinicalUse: "not-approved"`): `actionable` is always false while
 * that holds, and in any case when the state is not active or a dispute is open. It carries no report text, no span text and no note.
 */
export const evaluationDtoSchema = z.strictObject({
  id: z.uuid(),
  reportId: z.uuid(),
  patientId: z.uuid(),
  captureId: z.uuid(),
  /** The decision this relied on, and whether it is still the latest decision about its capture. */
  acceptance: z.strictObject({ id: z.uuid(), decision: z.enum(['accepted', 'rejected']), current: z.boolean() }).nullable(),
  disposition: z.enum(['held', 'evaluated']),
  holdCode: z.string().nullable(),
  /** For a held evaluation: fixed wording, never text from the report. */
  hold: z.strictObject({ message: z.string(), reviewerAction: z.string() }).nullable(),
  knowledgeSetId: z.string(),
  engineVersion: z.string(),
  scope: z.string().nullable(),
  clinicalUse: z.literal(CLINICAL_USE),
  state: z.enum(['active', 'retracted', 'superseded']),
  supersededBy: z.uuid().nullable(),
  results: z.array(evaluationResultDtoSchema),
  geneStates: z.array(evaluationGeneStateDtoSchema),
  /** What the engine received (gene states from the report), in the detail only. */
  geneInputs: z.array(z.looseObject({ gene: z.string(), state: z.string() })),
  /** Always empty until corrections exist (slice 5B-3.3). */
  corrections: z.array(z.looseObject({})),
  advisory: z.strictObject({ activeDisputes: z.number().int().min(0) }),
  actionable: z.literal(false),
  createdAt: timestamp,
});
export type EvaluationDto = z.infer<typeof evaluationDtoSchema>;

export const evaluationSummaryDtoSchema = evaluationDtoSchema.omit({ geneInputs: true });
export type EvaluationSummaryDto = z.infer<typeof evaluationSummaryDtoSchema>;

export const evaluationListQuerySchema = z.strictObject({ reportId: z.uuid().optional(), patientId: z.uuid().optional() });
export type EvaluationListQuery = z.infer<typeof evaluationListQuerySchema>;
