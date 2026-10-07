import { z } from 'zod';

/** CPIC's own strength-of-recommendation terms. */
export const RECOMMENDATION_STRENGTHS = ['Strong', 'Moderate', 'Optional', 'No recommendation'] as const;
export const recommendationStrengthSchema = z.enum(RECOMMENDATION_STRENGTHS);
export type RecommendationStrength = z.infer<typeof recommendationStrengthSchema>;

/**
 * PROVISIONAL shape: it is finalised in Phase 5 together with the CPIC specs and the gene list.
 * Recommendations are READ-ONLY through the API. They are produced only by the deterministic
 * rules engine (Phase 5); a client can never create one.
 */
export const recommendationDtoSchema = z.strictObject({
  id: z.uuid(),
  patientId: z.uuid(),
  reportId: z.uuid(),
  gene: z.string(),
  drug: z.string(),
  phenotype: z.string(),
  summary: z.string(),
  strength: recommendationStrengthSchema,
  guidelineVersion: z.string(),
  createdAt: z.iso.datetime(),
});
export type RecommendationDto = z.infer<typeof recommendationDtoSchema>;

export const recommendationListQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  patientId: z.uuid().optional(),
  reportId: z.uuid().optional(),
});
export type RecommendationListQuery = z.infer<typeof recommendationListQuerySchema>;
