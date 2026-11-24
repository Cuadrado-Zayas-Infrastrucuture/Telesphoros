import { AppException } from '../common/app-exception';
import type { Database } from '../db/database';

/** One audit row as security_audit_review() returns it: ids, a static route key, the kind, the outcome and the server's time. */
export interface AuditReadRow {
  event: 'private-read' | 'download-link';
  outcome: 'succeeded' | 'refused';
  member: string;
  routeKey: string;
  subjectId: string | null;
  occurredAt: Date;
}

export interface AuditReadFilter {
  member?: string;
  subjects?: string[];
  from: Date;
  to: Date;
  limit: number;
  offset: number;
}

/**
 * Spec 046: the organisation's reads, for its administrators. `reads` asks the database function, which checks the caller is a current admin; the
 * other two resolve ids to patients under the application's own row-level security. Every call takes the tenant and the caller as authenticated
 * code knows them, never from a request body.
 */
export abstract class AccessReviewRepository {
  abstract reads(tenantId: string, actor: string, filter: AuditReadFilter): Promise<AuditReadRow[]>;
  /** The evaluation and report ids of one patient, so a review by patient finds the rows whose subject is one of them. */
  abstract recordsOf(tenantId: string, actor: string, patientId: string): Promise<{ evaluations: string[]; reports: string[] }>;
  /** The patient of each given evaluation and report id that exists in the organisation. */
  abstract patientsOf(tenantId: string, actor: string, ids: { evaluations: string[]; reports: string[] }): Promise<Map<string, string>>;
}

/** The access audit is PostgreSQL only (0016): with the in-memory store the review answers 503, as the other PostgreSQL-only routes do. */
export class UnavailableAccessReviewRepository extends AccessReviewRepository {
  private refuse(): never {
    throw AppException.unavailable('The access review needs the PostgreSQL store.');
  }
  reads(): Promise<AuditReadRow[]> {
    this.refuse();
  }
  recordsOf(): Promise<{ evaluations: string[]; reports: string[] }> {
    this.refuse();
  }
  patientsOf(): Promise<Map<string, string>> {
    this.refuse();
  }
}

export class PostgresAccessReviewRepository extends AccessReviewRepository {
  constructor(private readonly db: Database) {
    super();
  }

  reads(tenantId: string, actor: string, filter: AuditReadFilter): Promise<AuditReadRow[]> {
    return this.db
      .withTenant(
        tenantId,
        async (c) => {
          const { rows } = await c.query<{
            event_type: AuditReadRow['event'];
            outcome: AuditReadRow['outcome'];
            actor_sub: string;
            route_key: string;
            subject_id: string | null;
            occurred_at: Date;
          }>(
            `SELECT event_type, outcome, actor_sub, route_key, subject_id::text AS subject_id, occurred_at
             FROM security_audit_review($1::text, $2::uuid[], $3::timestamptz, $4::timestamptz, $5::int, $6::int)`,
            [filter.member ?? null, filter.subjects ?? null, filter.from, filter.to, filter.limit, filter.offset],
          );
          return rows.map((r) => ({ event: r.event_type, outcome: r.outcome, member: r.actor_sub, routeKey: r.route_key, subjectId: r.subject_id, occurredAt: r.occurred_at }));
        },
        { actor },
      )
      .catch((error: { code?: string }) => {
        if (error?.code === '42501') throw AppException.forbidden();
        throw error;
      });
  }

  recordsOf(tenantId: string, actor: string, patientId: string): Promise<{ evaluations: string[]; reports: string[] }> {
    return this.db.withTenant(
      tenantId,
      async (c) => {
        const evaluations = await c.query<{ id: string }>('SELECT id::text AS id FROM evaluations WHERE tenant_id = $1 AND patient_id = $2', [tenantId, patientId]);
        const reports = await c.query<{ id: string }>('SELECT id::text AS id FROM reports WHERE tenant_id = $1 AND patient_id = $2', [tenantId, patientId]);
        return { evaluations: evaluations.rows.map((r) => r.id), reports: reports.rows.map((r) => r.id) };
      },
      { actor },
    );
  }

  patientsOf(tenantId: string, actor: string, ids: { evaluations: string[]; reports: string[] }): Promise<Map<string, string>> {
    return this.db.withTenant(
      tenantId,
      async (c) => {
        const found = new Map<string, string>();
        if (ids.evaluations.length > 0) {
          const { rows } = await c.query<{ id: string; patient_id: string }>(
            'SELECT id::text AS id, patient_id::text AS patient_id FROM evaluations WHERE tenant_id = $1 AND id = ANY($2::uuid[])',
            [tenantId, ids.evaluations],
          );
          for (const r of rows) found.set(r.id, r.patient_id);
        }
        if (ids.reports.length > 0) {
          const { rows } = await c.query<{ id: string; patient_id: string }>(
            'SELECT id::text AS id, patient_id::text AS patient_id FROM reports WHERE tenant_id = $1 AND id = ANY($2::uuid[])',
            [tenantId, ids.reports],
          );
          for (const r of rows) found.set(r.id, r.patient_id);
        }
        return found;
      },
      { actor },
    );
  }
}
