import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { JobQueue } from '@telesphoros/jobs';
import type { Database } from '../../src/db/database';
import { EvaluationRequestsService } from '../../src/lab-reports/evaluation-requests.service';
import { EvaluationRequestsRepository } from '../../src/storage/postgres/evaluation-requests.repository';
import { PostgresLedgerRecordsRepository } from '../../src/storage/postgres/ledger-records.repository';
import { type EphemeralDatabase, withAdmin } from './database';
import { acceptanceFor, captureFor, seedLabReport, sha } from './ledger-fixtures';

/** The synthetic execution profile the queued-evaluation specs admit under. */
export const QUEUED_PROFILE = {
  version: 'evaluation-execution-profile/1' as const,
  codeArtifactSha256: sha('code'),
  executionManifestSha256: sha('self-hosted manifest'),
  knowledgeSetId: sha('knowledge'),
  recordingsSha256: sha('recordings'),
};

export interface QueuedEvaluation {
  tenantId: string;
  sub: string;
  worker: string;
  job: string;
}

/**
 * Spec 012: one organization, one requester (a clinician, then `roles` if given), one admitted evaluation request and its job, claimed by `worker` unless
 * `claim` is false. Each call makes its own organization, so jobs from different tests never mix.
 */
export async function queuedEvaluation(pg: EphemeralDatabase, database: Database, options: { roles?: string[]; claim?: boolean; worker?: string } = {}): Promise<QueuedEvaluation> {
  const tenantId = `syn-${randomUUID()}`;
  const sub = `syn-requester-${randomUUID()}`;
  const worker = options.worker ?? `syn-worker-${randomUUID().slice(0, 8)}`;
  const report = await seedLabReport(pg.adminUrl, tenantId);
  await withAdmin(pg.adminUrl, (c) =>
    c.query(`INSERT INTO tenant_memberships (tenant_id,sub,status,roles,changed_by) VALUES ($1,$2,'active',ARRAY['clinician'],'syn-test')`, [tenantId, sub]),
  );
  const ledger = new PostgresLedgerRecordsRepository(database);
  const capture = captureFor(report);
  const stored = await ledger.insertCapture(tenantId, report.uploader, capture);
  const acceptance = await ledger.insertAcceptance(tenantId, 'syn-reviewer', acceptanceFor(stored.record.id, capture));
  await ledger.insertPatientDecision(tenantId, 'syn-verifier', {
    reportId: report.reportId,
    expectedReport: { patientId: report.patientId, sha256: report.pdfSha256, objectVersion: report.objectVersion },
    decision: 'verified',
    method: 'person-confirmed',
    basisCode: 'no-identifier-on-report',
  });
  const service = new EvaluationRequestsService(new EvaluationRequestsRepository(database), QUEUED_PROFILE);
  const { request } = await service.admit(
    { tenantId, sub, roles: ['clinician'] },
    { reportId: report.reportId, captureId: stored.record.id, acceptanceId: acceptance.record.id, requestId: randomUUID() },
  );
  if (options.roles) {
    await withAdmin(pg.adminUrl, (c) => c.query(`UPDATE tenant_memberships SET roles=$3, changed_by='syn-test' WHERE tenant_id=$1 AND sub=$2`, [tenantId, sub, options.roles]));
  }
  if (options.claim !== false) await claimJob(pg, request.jobId, worker);
  return { tenantId, sub, worker, job: request.jobId };
}

/** Claims jobs as the queue worker until `job` is among them. Every job a test makes is claimed in that test, so another test's job is never waiting. */
export async function claimJob(pg: EphemeralDatabase, job: string, worker: string): Promise<void> {
  const c = new Client({ connectionString: pg.workerUrl });
  await c.connect();
  try {
    const queue = new JobQueue(c);
    for (let i = 0; i < 20; i++) {
      const claimed = await queue.claim(worker, { types: ['evaluations.request'], batch: 1, tenantCap: 1, leaseSeconds: 60 });
      if (claimed.some((j) => j.id === job)) return;
      if (claimed.length === 0) break;
    }
  } finally {
    await c.end();
  }
  throw new Error('the test job was not claimed');
}
