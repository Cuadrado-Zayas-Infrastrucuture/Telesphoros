import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { enqueueJob, evaluationRequest } from '@telesphoros/jobs';
import type { EvaluationExecutionProfile, EvaluationRequestCreate, EvaluationRequestDto } from '@telesphoros/shared-types';
import type { Principal } from '../../auth/principal';
import { AppException } from '../../common/app-exception';
import type { Database } from '../../db/database';

export class EvaluationRequestsRepository {
  constructor(private readonly database: Database) {}

  admit(principal: Principal, input: EvaluationRequestCreate, profile: EvaluationExecutionProfile): Promise<{ request: EvaluationRequestDto; created: boolean }> {
    return this.access(principal, async (client) => {
      await client.query('SELECT evaluation_request_authorize(true)');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`evaluation-request:${principal.tenantId}:${principal.sub}:${input.requestId}`]);
      const basis = (await client.query('SELECT evaluation_request_basis($1,$2,$3) AS basis', [input.reportId, input.captureId, input.acceptanceId])).rows[0].basis;
      const tuple = { reportId: input.reportId, captureId: input.captureId, acceptanceId: input.acceptanceId, basis, executionProfile: profile };
      const fingerprint = (await client.query('SELECT evaluation_request_fingerprint($1::jsonb) AS fingerprint', [JSON.stringify(tuple)])).rows[0].fingerprint as string;
      const existing = await client.query<{ id: string; fingerprint: string }>(
        'SELECT id::text AS id,fingerprint FROM evaluation_requests WHERE tenant_id=$1 AND requested_by=$2 AND creation_request_id=$3',
        [principal.tenantId, principal.sub, input.requestId],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].fingerprint !== fingerprint)
          throw AppException.conflictBecause('idempotency-conflict', 'That retry identity belongs to a different evaluation request.');
        return { request: await this.mustRead(client, principal.tenantId, existing.rows[0].id), created: false };
      }
      const id = randomUUID();
      const { jobId } = await enqueueJob(client, evaluationRequest, { requestId: id }, { idempotencyKey: `evaluation-request:${id}` });
      await client.query(
        `INSERT INTO evaluation_requests (id,tenant_id,requested_by,creation_request_id,report_id,capture_id,acceptance_id,basis,execution_profile,job_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10)`,
        [id, principal.tenantId, principal.sub, input.requestId, input.reportId, input.captureId, input.acceptanceId, JSON.stringify(basis), JSON.stringify(profile), jobId],
      );
      return { request: await this.mustRead(client, principal.tenantId, id), created: true };
    });
  }

  get(principal: Principal, id: string): Promise<EvaluationRequestDto | undefined> {
    return this.access(principal, async (client) => {
      await client.query('SELECT evaluation_request_authorize(false)');
      return this.read(client, principal.tenantId, id);
    });
  }

  private async access<T>(principal: Principal, work: (client: PoolClient) => Promise<T>): Promise<T> {
    try {
      return await this.database.withTenant(principal.tenantId, work, { actor: principal.sub });
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === '42501') throw AppException.forbidden();
      if (code === 'ER001') throw AppException.conflictBecause('evaluation-basis-unavailable', 'Current accepted evaluation evidence is unavailable.');
      if (code === 'LC001') throw AppException.ledgerCompromised();
      throw error;
    }
  }

  private async mustRead(client: PoolClient, tenantId: string, id: string): Promise<EvaluationRequestDto> {
    const request = await this.read(client, tenantId, id);
    if (!request) throw AppException.unavailable('Evaluation request status is unavailable.');
    return request;
  }

  private async read(client: PoolClient, tenantId: string, id: string): Promise<EvaluationRequestDto | undefined> {
    const { rows } = await client.query<{
      id: string;
      report_id: string;
      capture_id: string;
      acceptance_id: string;
      job_id: string;
      requested_by: string;
      created_at: Date;
      job_state: string | null;
      bound: boolean | null;
      receipt_id: string | null;
      evaluation_id: string | null;
    }>(
      `SELECT r.id,r.report_id,r.capture_id,r.acceptance_id,r.job_id,r.requested_by,r.created_at,j.state AS job_state,
         (j.type='evaluations.request' AND j.payload=jsonb_build_object('requestId',r.id) AND j.requested_by=r.requested_by
           AND j.idempotency_key='evaluation-request:' || r.id::text) AS bound,
         c.request_id AS receipt_id,e.id AS evaluation_id
       FROM evaluation_requests r LEFT JOIN jobs j ON j.id=r.job_id AND j.tenant_id=r.tenant_id
       LEFT JOIN evaluation_request_completions c ON c.request_id=r.id AND c.tenant_id=r.tenant_id
       LEFT JOIN evaluations e ON e.id=c.evaluation_id AND e.tenant_id=r.tenant_id AND e.report_id=r.report_id
         AND e.capture_id=r.capture_id AND e.capture_acceptance_id=r.acceptance_id
         AND e.patient_id::text=r.basis->>'patientId' AND e.binding->>'textSha256'=r.basis->>'textSha256'
         AND e.knowledge_set_id=r.execution_profile->>'knowledgeSetId'
       WHERE r.tenant_id=$1 AND r.id=$2`,
      [tenantId, id],
    );
    const row = rows[0];
    if (!row) return undefined;
    if (!row.bound || !row.job_state || (row.receipt_id && !row.evaluation_id)) throw AppException.unavailable('Evaluation request status is unavailable.');
    let state: EvaluationRequestDto['state'];
    if (row.receipt_id) state = 'completed';
    else if (row.job_state === 'succeeded') state = 'completion-missing';
    else if (row.job_state === 'queued' || row.job_state === 'running' || row.job_state === 'retry' || row.job_state === 'dead') state = row.job_state;
    else throw AppException.unavailable('Evaluation request status is unavailable.');
    return {
      id: row.id,
      reportId: row.report_id,
      captureId: row.capture_id,
      acceptanceId: row.acceptance_id,
      jobId: row.job_id,
      requestedBy: row.requested_by,
      createdAt: row.created_at.toISOString(),
      state,
      evaluationId: row.evaluation_id,
    };
  }
}
