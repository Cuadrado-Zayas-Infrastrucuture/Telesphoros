import { Injectable } from '@nestjs/common';
import { byCreatedAt, type Page, type PageRequest, type RecommendationRecord, slicePage } from './records';

export interface RecommendationFilter {
  patientId?: string;
  reportId?: string;
}

/**
 * Recommendations are written ONLY by the deterministic rules engine (Phase 5), never by an HTTP
 * client, so the API exposes read methods only. `insert` exists for that engine and for tests.
 */
export abstract class RecommendationsRepository {
  abstract list(ownerId: string, page: PageRequest, filter: RecommendationFilter): Promise<Page<RecommendationRecord>>;
  abstract findById(ownerId: string, id: string): Promise<RecommendationRecord | undefined>;
  abstract insert(record: RecommendationRecord): Promise<void>;
}

@Injectable()
export class InMemoryRecommendationsRepository extends RecommendationsRepository {
  private readonly rows = new Map<string, RecommendationRecord>();

  async list(ownerId: string, page: PageRequest, filter: RecommendationFilter) {
    const rows = [...this.rows.values()].filter(
      (row) =>
        row.ownerId === ownerId &&
        (!filter.patientId || row.patientId === filter.patientId) &&
        (!filter.reportId || row.reportId === filter.reportId),
    );
    return slicePage(rows.sort(byCreatedAt), page);
  }
  async findById(ownerId: string, id: string) {
    const row = this.rows.get(id);
    return row && row.ownerId === ownerId ? { ...row } : undefined;
  }
  async insert(record: RecommendationRecord) {
    this.rows.set(record.id, { ...record });
  }
}
