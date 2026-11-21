import { z } from 'zod';
import { CLINICAL_USE } from './lab-report';

/**
 * Spec 044 slice A: one patient's genomic profile, their current medications checked against stored results, and optionally one drug
 * checked before it is prescribed. Read only; built from stored evaluations, never by running the engine (D6). SYNTHETIC, NON-PRODUCTION.
 */

/** `?rxcui=`: the same form a recorded medication's RxCUI takes (`patient-medications.ts`), so a synthetic `syn-rxcui-` id cannot be asked for. */
export const genomicProfileQuerySchema = z.strictObject({
  rxcui: z
    .string()
    .regex(/^[1-9][0-9]*$/, 'Choose a coded drug.')
    .max(16)
    .optional(),
});
export type GenomicProfileQuery = z.infer<typeof genomicProfileQuerySchema>;

/** The four words a check can carry (D4). "Guidelines changed" is the separate `knowledgeChanged` flag, shown beside any of them. */
export const GENOMIC_CHECK_WORDS = ['review', 'held', 'no-recommendation', 'no-guideline-loaded'] as const;
export const genomicCheckWordSchema = z.enum(GENOMIC_CHECK_WORDS);
export type GenomicCheckWord = z.infer<typeof genomicCheckWordSchema>;

export const genomicGeneSourceSchema = z.strictObject({
  evaluationId: z.uuid(),
  reportId: z.uuid(),
  /** The evaluation's `createdAt`, in the same form the evaluation DTO gives it (a non-empty string, not re-parsed). */
  evaluatedAt: z.string().min(1),
  state: z.string(),
  phenotype: z.string().nullable(),
  diplotype: z.string().nullable(),
  activityScore: z.string().nullable(),
  reasonCode: z.string().nullable(),
});
export type GenomicGeneSource = z.infer<typeof genomicGeneSourceSchema>;

export const genomicGeneSchema = z.strictObject({
  gene: z.string(),
  /** `resolved`: every source agrees; `conflict`: two sources differ and both are listed; `not-resolved`: named, but no source resolved it. */
  status: z.enum(['resolved', 'conflict', 'not-resolved']),
  sources: z.array(genomicGeneSourceSchema).min(1),
});
export type GenomicGene = z.infer<typeof genomicGeneSchema>;

export const genomicCheckResultSchema = z.strictObject({
  evaluationId: z.uuid(),
  resultId: z.uuid(),
  outcome: z.string(),
  reasonCode: z.string().nullable(),
  strength: z.string().nullable(),
  recommendationText: z.string().nullable(),
  implication: z.string().nullable(),
  citation: z.looseObject({}).nullable(),
  genes: z.array(z.string()),
});
export type GenomicCheckResult = z.infer<typeof genomicCheckResultSchema>;

export const genomicCheckSchema = z.strictObject({
  rxcui: z.string(),
  /** The recorded medication's name; null for a `?rxcui=` check, whose name the caller already has. */
  name: z.string().nullable(),
  word: genomicCheckWordSchema,
  /** True when a result relied on guidelines that are no longer the loaded ones, or, for `no-guideline-loaded`, when any evaluation did. */
  knowledgeChanged: z.boolean(),
  /** True when a gene a matching result used is in conflict between sources. */
  conflict: z.boolean(),
  /** Every matching result, so a held result beside a shown one is visible (P1). Empty for `no-guideline-loaded`. */
  results: z.array(genomicCheckResultSchema),
});
export type GenomicCheck = z.infer<typeof genomicCheckSchema>;

export const genomicProfileDtoSchema = z.strictObject({
  patientId: z.uuid(),
  clinicalUse: z.literal(CLINICAL_USE),
  /** True when the patient has more current evaluations than were read; the profile then says so instead of claiming to be complete. */
  capped: z.boolean(),
  genes: z.array(genomicGeneSchema),
  /** Current evaluations whose patient link a second person has not verified: listed, never used (D2). */
  awaitingLinkReview: z.array(z.strictObject({ evaluationId: z.uuid(), reportId: z.uuid() })),
  /** One per current, active medication. */
  medications: z.array(genomicCheckSchema),
  /** The `?rxcui=` check, or null without one. */
  check: genomicCheckSchema.nullable(),
});
export type GenomicProfileDto = z.infer<typeof genomicProfileDtoSchema>;
