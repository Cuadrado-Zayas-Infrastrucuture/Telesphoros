import { type RecommendationDto, recommendationDtoSchema } from '@telesphoros/shared-types';
import type { RecommendationRecord } from '../storage/records';

export function toRecommendationDto(record: RecommendationRecord): RecommendationDto {
  return recommendationDtoSchema.parse({
    id: record.id,
    patientId: record.patientId,
    reportId: record.reportId,
    gene: record.gene,
    drug: record.drug,
    phenotype: record.phenotype,
    summary: record.summary,
    strength: record.strength,
    guidelineVersion: record.guidelineVersion,
    createdAt: record.createdAt,
  });
}
