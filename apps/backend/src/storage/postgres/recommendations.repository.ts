import { Injectable } from '@nestjs/common';
import type { RecommendationStrength } from '@telesphoros/shared-types';
import { Database } from '../../db/database';
import { toStorageError } from '../errors';
import { type RecommendationFilter, RecommendationsRepository } from '../recommendations.repository';
import type { Page, PageRequest, RecommendationRecord } from '../records';

interface RecommendationRow {
  id: string;
  owner_id: string;
  patient_id: string;
  report_id: string;
  gene: string;
  drug: string;
  phenotype: string;
  summary: string;
  strength: RecommendationStrength;
  guideline_version: string;
  created_at: Date;
}

const COLUMNS =
  'id, owner_id, patient_id, report_id, gene, drug, phenotype, summary, strength, guideline_version, created_at';

const toRecord = (row: RecommendationRow): RecommendationRecord => ({
  id: row.id,
  ownerId: row.owner_id,
  patientId: row.patient_id,
  reportId: row.report_id,
  gene: row.gene,
  drug: row.drug,
  phenotype: row.phenotype,
  summary: row.summary,
  strength: row.strength,
  guidelineVersion: row.guideline_version,
  createdAt: row.created_at.toISOString(),
});

@Injectable()
export class PostgresRecommendationsRepository extends RecommendationsRepository {
  constructor(private readonly db: Database) {
    super();
  }

  list(ownerId: string, { offset, limit }: PageRequest, filter: RecommendationFilter): Promise<Page<RecommendationRecord>> {
    return this.db.withOwner(ownerId, async (client) => {
      const where = `owner_id = $1 AND deleted_at IS NULL
                     AND ($2::uuid IS NULL OR patient_id = $2::uuid)
                     AND ($3::uuid IS NULL OR report_id = $3::uuid)`;
      const params = [ownerId, filter.patientId ?? null, filter.reportId ?? null];
      const rows = await client.query<RecommendationRow>(
        `SELECT ${COLUMNS} FROM recommendations WHERE ${where} ORDER BY seq LIMIT $4 OFFSET $5`,
        [...params, limit, offset],
      );
      const total = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM recommendations WHERE ${where}`, params);
      return { items: rows.rows.map(toRecord), total: total.rows[0]!.n };
    });
  }

  findById(ownerId: string, id: string): Promise<RecommendationRecord | undefined> {
    return this.db.withOwner(ownerId, async (client) => {
      const { rows } = await client.query<RecommendationRow>(
        `SELECT ${COLUMNS} FROM recommendations WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL`,
        [id, ownerId],
      );
      return rows[0] ? toRecord(rows[0]) : undefined;
    });
  }

  async insert(record: RecommendationRecord): Promise<void> {
    try {
      await this.db.withOwner(record.ownerId, (client) =>
        client.query(
          `INSERT INTO recommendations (id, owner_id, patient_id, report_id, gene, drug, phenotype, summary,
                                        strength, guideline_version, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            record.id, record.ownerId, record.patientId, record.reportId, record.gene, record.drug,
            record.phenotype, record.summary, record.strength, record.guidelineVersion, record.createdAt,
          ],
        ),
      );
    } catch (error) {
      throw toStorageError(error);
    }
  }
}
