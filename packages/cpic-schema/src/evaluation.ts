import { z } from 'zod';
import { drugNameSchema, geneSymbolSchema } from './knowledge';
import { callerReasonCodeSchema, cpicStrengthSchema, reasonCodeSchema, verificationStateSchema } from './vocabulary';

/**
 * What the report adapter hands the engine for one occurrence of a gene in a report. The engine never
 * sees the report itself.
 *
 *   canonical   the report states a phenotype; it must be one of the gene's canonical terms
 *   diplotype   the report states a diplotype; the engine maps it with the gene's tables
 *   null        the report says "no result" (or similar) where a value should be
 *   unresolved  the adapter could not turn what the report says into a value
 *
 * A gene that is simply not mentioned is not an input at all: it is `absent`.
 */
export const geneInputSchema = z.discriminatedUnion('state', [
  z.strictObject({ gene: geneSymbolSchema, state: z.literal('canonical'), phenotype: z.string().max(100) }),
  z.strictObject({ gene: geneSymbolSchema, state: z.literal('diplotype'), diplotype: z.string().max(100) }),
  z.strictObject({ gene: geneSymbolSchema, state: z.literal('null') }),
  z.strictObject({ gene: geneSymbolSchema, state: z.literal('unresolved'), reasonCode: callerReasonCodeSchema }),
]);
export type GeneInput = z.infer<typeof geneInputSchema>;

export const MAX_GENE_INPUTS = 200;
export const geneInputsSchema = z.array(geneInputSchema).max(MAX_GENE_INPUTS);

export const evaluationOptionsSchema = z.strictObject({
  /** Drugs to evaluate. Omit to evaluate every drug the loaded guidelines cover; an empty list evaluates none. */
  drugs: z.array(drugNameSchema).max(500).optional(),
});
export type EvaluationOptions = z.infer<typeof evaluationOptionsSchema>;

/** The resolved state of one gene, after duplicates, sentinels and diplotypes have been dealt with. */
export const geneStateResultSchema = z.discriminatedUnion('state', [
  z.strictObject({
    gene: geneSymbolSchema,
    state: z.literal('canonical'),
    phenotype: z.string(),
    /** Present only when the phenotype came from a diplotype: its one canonical spelling. */
    diplotype: z.string().nullable(),
    /** Present only for genes mapped by activity score. */
    activityScore: z.number().nullable(),
    reasonCode: z.null(),
  }),
  z.strictObject({
    gene: geneSymbolSchema,
    state: z.enum(['absent', 'null', 'unresolved']),
    phenotype: z.null(),
    diplotype: z.null(),
    activityScore: z.null(),
    reasonCode: reasonCodeSchema,
  }),
]);
export type GeneStateResult = z.infer<typeof geneStateResultSchema>;

/** The genes behind one result, kept brief. */
const geneEvidenceSchema = z.strictObject({
  gene: geneSymbolSchema,
  state: z.enum(['canonical', 'absent', 'null', 'unresolved']),
  phenotype: z.string().nullable(),
  reasonCode: reasonCodeSchema.nullable(),
});
export type GeneEvidence = z.infer<typeof geneEvidenceSchema>;

/** Where the answer comes from, in enough detail for a person to check it against the published source. */
export const citationSchema = z.strictObject({
  guidelineId: z.string(),
  guidelineVersion: z.string(),
  sourceUrl: z.string(),
  locator: z.strictObject({ table: z.string(), row: z.string(), column: z.string().nullable() }),
  verification: verificationStateSchema,
});
export type Citation = z.infer<typeof citationSchema>;

const base = {
  drug: drugNameSchema,
  genes: z.array(geneSymbolSchema),
  geneStates: z.array(geneEvidenceSchema),
};

/**
 * One result per drug and guideline. The guideline's wording and strength appear ONLY in `shown`
 * and in `no-published-recommendation` (when the guideline itself says "No recommendation"): a cell
 * that is unverified or disputed never exposes its wording.
 */
export const drugResultSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    outcome: z.literal('shown'),
    ...base,
    strength: cpicStrengthSchema,
    citation: citationSchema,
    /** The guideline's wording, verbatim. */
    recommendationText: z.string(),
    implication: z.string().nullable(),
  }),
  z.strictObject({
    outcome: z.literal('no-published-recommendation'),
    ...base,
    reasonCode: z.literal('no-published-recommendation'),
    /** Present when a verified cell says "No recommendation"; absent when the guideline has no cell for this case. */
    citation: citationSchema.nullable(),
    strength: cpicStrengthSchema.nullable(),
    recommendationText: z.string().nullable(),
    implication: z.string().nullable(),
  }),
  z.strictObject({
    outcome: z.literal('held'),
    ...base,
    reasonCode: reasonCodeSchema,
    /** Present for out-of-review-scope and cell-disputed, so a reviewer can find the cell. No wording. */
    citation: citationSchema.nullable(),
  }),
  z.strictObject({
    outcome: z.literal('abstained'),
    ...base,
    reasonCode: z.literal('association-abstained'),
  }),
  z.strictObject({
    outcome: z.literal('no-guideline'),
    drug: drugNameSchema,
    genes: z.tuple([]),
    geneStates: z.tuple([]),
    reasonCode: z.literal('no-guideline-for-drug'),
  }),
]);
export type DrugResult = z.infer<typeof drugResultSchema>;

export const evaluationResultSchema = z.strictObject({
  /** Identifies exactly which knowledge files produced this result. */
  knowledgeSetId: z.string().regex(/^[0-9a-f]{64}$/),
  geneStates: z.array(geneStateResultSchema),
  results: z.array(drugResultSchema),
});
export type EvaluationResult = z.infer<typeof evaluationResultSchema>;
