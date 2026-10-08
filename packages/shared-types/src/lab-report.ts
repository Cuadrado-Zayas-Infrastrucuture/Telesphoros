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

// ---------------------------------------------------------------------------------------------------------------- corrections

export const CORRECTION_KINDS = ['retraction', 'supersession', 'reinstatement'] as const;
export const CORRECTION_REASON_CODES = [
  'capture-wrong', 'wrong-patient', 'input-misread', 'knowledge-error-found', 'software-defect', 'clinical-review-disagrees', 'retraction-mistaken',
] as const;
export type CorrectionKind = (typeof CORRECTION_KINDS)[number];
export type CorrectionReasonCode = (typeof CORRECTION_REASON_CODES)[number];

/** Which reason codes each kind may carry (specification 4.2). The database repeats this as a check constraint. */
export const REASONS_FOR_KIND: Record<CorrectionKind, readonly CorrectionReasonCode[]> = {
  retraction: ['capture-wrong', 'wrong-patient', 'input-misread', 'knowledge-error-found', 'software-defect', 'clinical-review-disagrees'],
  supersession: ['capture-wrong', 'input-misread', 'knowledge-error-found', 'software-defect'],
  reinstatement: ['retraction-mistaken'],
};

/**
 * `POST /evaluations/:id/corrections`. `previousCorrectionId` is the last correction the caller SAW (omitted when there is none): a reviewer
 * acts on what they were looking at, and a stale view is refused. Nothing about the evaluation or its report is taken from the body.
 */
export const correctionCreateSchema = z
  .strictObject({
    kind: z.enum(CORRECTION_KINDS),
    reasonCode: z.enum(CORRECTION_REASON_CODES),
    previousCorrectionId: z.uuid().optional(),
    replacementEvaluationId: z.uuid().optional(),
    note: z.string().trim().min(1).max(MAX_NOTE_LENGTH).optional(),
  })
  .superRefine((body, ctx) => {
    const problem = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    if (!REASONS_FOR_KIND[body.kind].includes(body.reasonCode)) problem('reasonCode', 'This reason is not allowed for this kind of correction.');
    if (body.kind === 'supersession' && !body.replacementEvaluationId) problem('replacementEvaluationId', 'A supersession names the evaluation that replaces this one.');
    if (body.kind !== 'supersession' && body.replacementEvaluationId) problem('replacementEvaluationId', 'Only a supersession names a replacement.');
    if (body.kind === 'reinstatement' && !body.previousCorrectionId) problem('previousCorrectionId', 'A reinstatement names the retraction it undoes.');
    if (body.reasonCode === 'clinical-review-disagrees' && !body.note) problem('note', 'This reason needs a note.');
  });
export type CorrectionCreate = z.infer<typeof correctionCreateSchema>;

/** A correction as the API shows it. The note is a digest of a stored note, never its text (read it with `GET /notes/:id`). */
export const correctionDtoSchema = z.strictObject({
  id: z.uuid(),
  evaluationId: z.uuid(),
  kind: z.enum(CORRECTION_KINDS),
  reasonCode: z.enum(CORRECTION_REASON_CODES),
  previousCorrectionId: z.uuid().nullable(),
  replacementEvaluationId: z.uuid().nullable(),
  note: z.strictObject({ id: z.uuid(), bodySha256: sha256 }).nullable(),
  createdAt: timestamp,
});
export type CorrectionDto = z.infer<typeof correctionDtoSchema>;

/** `GET /notes/:id`. A redacted note reads as the fixed tombstone with `redacted: true`; its digest still matches what the ledger committed to. */
export const noteDtoSchema = z.strictObject({
  id: z.uuid(),
  body: z.string(),
  bodySha256: sha256,
  redacted: z.boolean(),
  createdAt: timestamp,
});
export type NoteDto = z.infer<typeof noteDtoSchema>;

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
  /** Every correction about this evaluation, oldest first. The evaluation itself is never changed; `state` is derived from the last one. */
  corrections: z.array(correctionDtoSchema),
  /** True for the latest active evaluation of its report (specification 4.5). An older active evaluation becomes current again if a newer one is retracted. */
  current: z.boolean(),
  advisory: z.strictObject({ activeDisputes: z.number().int().min(0) }),
  actionable: z.literal(false),
  createdAt: timestamp,
});
export type EvaluationDto = z.infer<typeof evaluationDtoSchema>;

export const evaluationSummaryDtoSchema = evaluationDtoSchema.omit({ geneInputs: true });
export type EvaluationSummaryDto = z.infer<typeof evaluationSummaryDtoSchema>;

export const evaluationListQuerySchema = z.strictObject({
  reportId: z.uuid().optional(),
  patientId: z.uuid().optional(),
  /** `current=true` keeps only the current evaluation of each report. Only the value `true` is accepted. */
  current: z.literal('true').optional(),
});
export type EvaluationListQuery = z.infer<typeof evaluationListQuerySchema>;
