import { Injectable } from '@nestjs/common';
import { Database } from '../../db/database';
import { type UsageActivity, UsageRepository, type UsageStorage } from '../usage.repository';

/**
 * Aggregates through the application role, so row-level security already limits every row to the caller's tenant; each query states the
 * tenant filter too. Counts come back as text (bigint), and are parsed here.
 */
@Injectable()
export class PostgresUsageRepository extends UsageRepository {
  constructor(private readonly db: Database) {
    super();
  }

  activity(tenantId: string, from: Date, to: Date): Promise<UsageActivity> {
    return this.db.withTenant(tenantId, async (client) => {
      const reports = await client.query<{ uploaded: string }>('SELECT count(*) AS uploaded FROM reports WHERE tenant_id = $1 AND uploaded_at >= $2 AND uploaded_at < $3', [
        tenantId,
        from,
        to,
      ]);
      const evaluations = await client.query<{ evaluated: string; held: string }>(
        `SELECT count(*) FILTER (WHERE disposition = 'evaluated') AS evaluated, count(*) FILTER (WHERE disposition = 'held') AS held
           FROM evaluations WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3`,
        [tenantId, from, to],
      );
      return { reportsUploaded: Number(reports.rows[0]!.uploaded), evaluated: Number(evaluations.rows[0]!.evaluated), held: Number(evaluations.rows[0]!.held) };
    });
  }

  storage(tenantId: string): Promise<UsageStorage> {
    return this.db.withTenant(tenantId, async (client) => {
      const { rows } = await client.query<{ files: string; bytes: string }>(
        'SELECT count(*) AS files, coalesce(sum(size_bytes), 0) AS bytes FROM reports WHERE tenant_id = $1 AND uploaded_at IS NOT NULL AND deleted_at IS NULL',
        [tenantId],
      );
      return { reportFiles: Number(rows[0]!.files), reportBytes: Number(rows[0]!.bytes) };
    });
  }
}
