import type { Queryable } from '@telesphoros/jobs';
import type { JobData, VerifyOutcome, VerifyTarget } from './deps';

const target = (r: Record<string, unknown>): VerifyTarget => ({
  reportId: r.report_id as string, storageKey: r.storage_key as string, objectVersion: r.object_version as string, sha256: r.sha256 as string,
  sizeBytes: Number(r.size_bytes), contentType: r.content_type as string,
});

/** The database side of the consumers: each call is one SQL function of migration 0024 (the worker login can call nothing else on these tables). */
export class PgJobData implements JobData {
  constructor(private readonly db: Queryable) {}

  async verifyTarget(jobId: string, workerId: string) {
    const { rows } = await this.db.query('SELECT * FROM file_verification_target($1, $2)', [jobId, workerId]);
    return rows[0] ? target(rows[0]) : undefined;
  }

  async verifyStale(jobId: string, workerId: string, limit: number, maxAgeSeconds: number) {
    const { rows } = await this.db.query('SELECT * FROM file_verification_stale($1, $2, $3, $4)', [jobId, workerId, limit, maxAgeSeconds]);
    return rows.map(target);
  }

  async recordVerification(jobId: string, workerId: string, reportId: string, outcome: VerifyOutcome, reason: string | undefined, objectVersion: string) {
    await this.db.query('SELECT file_verification_record($1, $2, $3, $4, $5, $6)', [jobId, workerId, reportId, outcome, reason ?? null, objectVersion]);
  }

  async sweepUploads(jobId: string, workerId: string) {
    const { rows } = await this.db.query('SELECT * FROM job_uploads_sweep($1, $2)', [jobId, workerId]);
    const r = rows[0]!;
    return { released: Number(r.released), releasedBytes: Number(r.released_bytes), objectsKept: Number(r.objects_kept) };
  }
}
