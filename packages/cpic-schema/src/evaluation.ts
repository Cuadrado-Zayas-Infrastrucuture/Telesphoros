import { z } from 'zod';
import { drugNameSchema, geneSymbolSchema } from './knowledge';
import { callerReasonCodeSchema, cpicStrengthSchema, indeterminateReasonCodeSchema } from './vocabulary';

/**
 * What a report parser hands the engine for one gene: either a diplotype, or the reason it could
 * not make one. The engine never sees the report itself.
 */
export const geneCallSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ gene: geneSymbolSchema, outcome: z.literal('called'), diplotype: z.string().max(100) }),
  z.strictObject({ gene: geneSymbolSchema, outcome: z.literal('indeterminate'), reasonCode: callerReasonCodeSchema }),
]);
export type GeneCall = z.infer<typeof geneCallSchema>;

export const MAX_GENE_CALLS = 200;
export const geneCallsSchema = z.array(geneCallSchema).max(MAX_GENE_CALLS);

export const evaluationOptionsSchema = z.strictObject({
  /** Drugs to evaluate. Omit to evaluate every drug the loaded guidelines cover. */
  drugs: z.array(drugNameSchema).max(500).optional(),
});
export type EvaluationOptions = z.infer<typeof evaluationOptionsSchema>;

export const phenotypeResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('determined'),
    gene: geneSymbolSchema,
    /** The diplotype in its one canonical spelling. */
    diplotype: z.string(),
    phenotype: z.string(),
    /** Present only for genes mapped by activity score. */
    activityScore: z.number().nullable(),
  }),
  z.strictObject({ status: z.literal('indeterminate'), gene: geneSymbolSchema, reasonCode: indeterminateReasonCodeSchema }),
]);
export type PhenotypeResult = z.infer<typeof phenotypeResultSchema>;

export const recommendationResultSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('recommendation'),
    gene: geneSymbolSchema,
    drug: drugNameSchema,
    diplotype: z.string(),
    phenotype: z.string(),
    /** Kept as separate fields (not inside the text) so they can be filtered, audited and exported. */
    strength: cpicStrengthSchema,
    guidelineId: z.string(),
    guidelineVersion: z.string(),
    sourceUrl: z.string(),
    /** The guideline's wording, verbatim. */
    recommendationText: z.string(),
    implication: z.string().nullable(),
  }),
  z.strictObject({
    status: z.literal('indeterminate'),
    drug: drugNameSchema.nullable(),
    gene: geneSymbolSchema.nullable(),
    reasonCode: indeterminateReasonCodeSchema,
  }),
]);
export type RecommendationResult = z.infer<typeof recommendationResultSchema>;

export const evaluationResultSchema = z.strictObject({
  /** Identifies exactly which knowledge files produced this result. */
  knowledgeSetId: z.string().regex(/^[0-9a-f]{64}$/),
  phenotypes: z.array(phenotypeResultSchema),
  recommendations: z.array(recommendationResultSchema),
});
export type EvaluationResult = z.infer<typeof evaluationResultSchema>;
