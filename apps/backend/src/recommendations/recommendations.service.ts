import { Injectable } from '@nestjs/common';
import type { RecommendationListQuery } from '@telesphoros/shared-types';
import { AppException } from '../common/app-exception';
import type { Principal } from '../auth/principal';
import { RecommendationsRepository } from '../storage/recommendations.repository';
import type { RecommendationRecord } from '../storage/records';

/** Read-only by design: only the deterministic rules engine (Phase 5) creates recommendations. */
@Injectable()
export class RecommendationsService {
  constructor(private readonly recommendations: RecommendationsRepository) {}

  list(principal: Principal, { page, pageSize, patientId, reportId }: RecommendationListQuery) {
    return this.recommendations.list(
      principal.sub,
      { offset: (page - 1) * pageSize, limit: pageSize },
      { patientId, reportId },
    );
  }

  async get(principal: Principal, id: string): Promise<RecommendationRecord> {
    const record = await this.recommendations.findById(principal.sub, id);
    if (!record) throw AppException.notFound('Recommendation not found.');
    return record;
  }
}
