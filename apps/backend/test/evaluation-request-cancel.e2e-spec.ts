import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Pool } from 'pg';
import { evaluationRequest, JobQueue, type ClaimedJob } from '@telesphoros/jobs';
import type { EvaluationExecutionProfile } from '@telesphoros/shared-types';
import { AppException } from '../src/common/app-exception';
import { Database } from '../src/db/database';
import { EvaluationRequestConsumer } from '../src/lab-reports/evaluation-request-consumer';
import { EvaluationRequestsService } from '../src/lab-reports/evaluation-requests.service';
import { EvaluationsService, LAB_KNOWLEDGE } from '../src/lab-reports/evaluations.service';
import { TextCaptureRunner } from '../src/lab-reports/runner/text-capture-runner';
import type { KnowledgeSet } from '../src/services/knowledge/knowledge-set';
import { EvaluationRequestsRepository } from '../src/storage/postgres/evaluation-requests.repository';
import { createTestApp, usingPostgres } from './helpers/app';
import { createEphemeralDatabase, type EphemeralDatabase } from './helpers/database';
import { fixturePdf, LabPipeline, sha, type Person } from './helpers/lab-pipeline';
import { bearer } from './helpers/tokens';

// H4 slice 2 (spec 007): the person who queued an evaluation can cancel it while no worker has started it, on the real stack (migrations, roles, row-level
// security, the real queue functions) with the public synthetic fixture D01. Asserted through the service, the queue and the stored rows: the route is slice 3.
// A cancelled request is never evaluated, and a cancel and a claim never both succeed.
(usingPostgres() ? describe : describe.skip)('cancelling an evaluation request that has not started (H4)', () => {
  let db: EphemeralDatabase;
  let app: NestExpressApplication;
  let lab: LabPipeline;
  let workerPool: Pool;
  let queue: JobQueue;
  let profile: EvaluationExecutionProfile;
  let service: EvaluationRequestsService;

  beforeAll(async () => {
    db = await createEphemeralDatabase();
    app = await createTestApp({ labReportPipeline: true, postgresUrl: db.appUrl });
    lab = new LabPipeline(app, db.adminUrl);
    workerPool = new Pool({ connectionString: db.workerUrl, max: 4 });
    queue = new JobQueue(workerPool);
    profile = {
      version: 'evaluation-execution-profile/1',
      codeArtifactSha256: sha('synthetic code artifact'),
      executionManifestSha256: sha('synthetic self-hosted manifest'),
      knowledgeSetId: app.get<KnowledgeSet>(LAB_KNOWLEDGE).id,
      recordingsSha256: app.get(TextCaptureRunner).manifestSha256,
    };
    service = new EvaluationRequestsService(new EvaluationRequestsRepository(app.get(Database)), profile);
  }, 60_000);
  afterAll(async () => {
    await workerPool?.end();
    await app?.close();
    await db?.drop();
  });

  // Each test claims only its own job: earlier tests' jobs are taken out of the queue first, as an operator would, so a claim cannot be handed one of them.
  beforeEach(async () => {
    await lab.row(`UPDATE jobs SET state = 'cancelled', finished_at = now(), updated_at = now() WHERE state IN ('queued', 'retry')`);
    await lab.row(`UPDATE jobs SET state = 'dead', lease_until = NULL, locked_by = NULL, finished_at = now(), updated_at = now() WHERE state = 'running'`);
  });

  /** A person whose membership exists (it is mirrored from the token on their first request), so a refusal is the rule's and not a missing member's. */
  async function member(name: string, roles: string[], tenant = lab.tenant): Promise<Person> {
    const person = await lab.person(name, roles, tenant);
    await lab.api().get('/api/v1/me').set(bearer(person.token)).expect(200);
    return person;
  }

  const as = (sub: string, roles: Array<'clinician' | 'reviewer' | 'reader'> = ['clinician'], tenantId = lab.tenant) => ({ tenantId, sub, roles });

  /** A reviewed, linked D01 report and a request admitted by its clinician. */
  async function queued() {
    const setup = await lab.reviewedCapture(fixturePdf('D01'));
    const principal = as(setup.clinician.sub);
    const { request } = await service.admit(principal, { requestId: randomUUID(), reportId: setup.reportId, captureId: setup.captureId, acceptanceId: setup.acceptanceId });
    return { setup, principal, request };
  }

  /** Claims `jobId` for `workerId`, releasing anything else the claim returned; undefined when the queue does not hand it out. */
  async function claim(workerId: string, jobId: string): Promise<ClaimedJob | undefined> {
    for (let i = 0; i < 5; i++) {
      const jobs = await queue.claim(workerId, { types: [evaluationRequest.type], batch: 10, tenantCap: 50, leaseSeconds: 60 });
      const mine = jobs.find((j) => j.id === jobId);
      for (const other of jobs.filter((j) => j !== mine)) await queue.release(other.id, workerId);
      if (mine) return mine;
      if (jobs.length === 0) return undefined;
    }
    return undefined;
  }

  const refusal = async (promise: Promise<unknown>) => {
    const error = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(AppException);
    const e = error as AppException;
    return { status: e.getStatus(), reason: e.details?.[0]?.reason };
  };
  const jobState = async (jobId: string) => (await lab.row<{ state: string }>('SELECT state FROM jobs WHERE id = $1', [jobId]))[0]!.state;
  const cancellations = (requestId: string) => lab.count('evaluation_request_cancellations', 'request_id = $1', [requestId]);

  it('lets the requester cancel a queued request: the job is cancelled, the person is recorded, and the request reads as cancelled', async () => {
    const { principal, request } = await queued();

    const cancelled = await service.cancel(principal, request.id);

    expect(cancelled).toMatchObject({ id: request.id, state: 'cancelled', evaluationId: null });
    expect(await jobState(request.jobId)).toBe('cancelled');
    const [record] = await lab.row<{ cancelled_by: string; tenant_id: string }>('SELECT cancelled_by, tenant_id FROM evaluation_request_cancellations WHERE request_id = $1', [
      request.id,
    ]);
    expect(record).toEqual({ cancelled_by: principal.sub, tenant_id: lab.tenant });
    const reader = await member('reader', ['reader']);
    expect((await service.get(as(reader.sub, ['reader']), request.id)).state).toBe('cancelled');
  }, 60_000);

  it('cancels a request waiting to retry', async () => {
    const { principal, request } = await queued();
    await lab.row(`UPDATE jobs SET state = 'retry', attempts = 1, run_after = now() + interval '1 hour' WHERE id = $1`, [request.jobId]);
    expect((await service.get(principal, request.id)).state).toBe('retry');

    expect((await service.cancel(principal, request.id)).state).toBe('cancelled');
  }, 60_000);

  it('never evaluates a cancelled request: no worker is handed its job, and nothing is stored', async () => {
    const { setup, principal, request } = await queued();
    await service.cancel(principal, request.id);

    expect(await claim('w-after-cancel', request.jobId)).toBeUndefined();
    expect(await lab.count('evaluations', 'report_id = $1', [setup.reportId])).toBe(0);
    expect(await lab.count('evaluation_request_completions', 'request_id = $1', [request.id])).toBe(0);
  }, 60_000);

  it.each([
    ['running', async (jobId: string) => void (await claim('w-running', jobId))],
    ['dead', async (jobId: string) => void (await lab.row(`UPDATE jobs SET state = 'dead', finished_at = now() WHERE id = $1`, [jobId]))],
  ])(
    'refuses to cancel a %s request (409) and records nothing',
    async (state, put) => {
      const { principal, request } = await queued();
      await put(request.jobId);
      expect(await jobState(request.jobId)).toBe(state);

      expect(await refusal(service.cancel(principal, request.id))).toEqual({ status: 409, reason: 'not-cancellable' });
      expect(await jobState(request.jobId)).toBe(state);
      expect(await cancellations(request.id)).toBe(0);
    },
    60_000,
  );

  it('refuses to cancel a completed request (409), and leaves it completed', async () => {
    const { principal, request } = await queued();
    const job = await claim('w-complete', request.jobId);
    await new EvaluationRequestConsumer(app.get(Database), app.get(EvaluationsService), profile).handle({
      job: job!,
      workerId: 'w-complete',
      signal: new AbortController().signal,
    });
    expect((await service.get(principal, request.id)).state).toBe('completed');

    expect(await refusal(service.cancel(principal, request.id))).toEqual({ status: 409, reason: 'not-cancellable' });
    expect((await service.get(principal, request.id)).state).toBe('completed');
    expect(await cancellations(request.id)).toBe(0);
  }, 60_000);

  it('refuses a second cancel (409), and keeps the one record', async () => {
    const { principal, request } = await queued();
    await service.cancel(principal, request.id);

    expect(await refusal(service.cancel(principal, request.id))).toEqual({ status: 409, reason: 'not-cancellable' });
    expect(await cancellations(request.id)).toBe(1);
  }, 60_000);

  it('refuses a colleague who did not queue it, and a reader (403), then lets the requester cancel (control)', async () => {
    const { principal, request } = await queued();
    const colleague = await member('colleague', ['clinician']);
    const reader = await member('reader', ['reader']);

    expect(await refusal(service.cancel(as(colleague.sub), request.id))).toEqual({ status: 403, reason: undefined });
    expect(await refusal(service.cancel(as(reader.sub, ['reader']), request.id))).toEqual({ status: 403, reason: undefined });
    expect(await jobState(request.jobId)).toBe('queued');
    expect(await cancellations(request.id)).toBe(0);

    expect((await service.cancel(principal, request.id)).state).toBe('cancelled');
  }, 60_000);

  it('refuses the requester once they no longer hold a write role (403), and keeps the job queued', async () => {
    const { principal, request } = await queued();
    await lab.row(`UPDATE tenant_memberships SET roles = ARRAY['reader'] WHERE tenant_id = $1 AND sub = $2`, [lab.tenant, principal.sub]);

    expect(await refusal(service.cancel(as(principal.sub, ['reader']), request.id))).toEqual({ status: 403, reason: undefined });
    expect(await jobState(request.jobId)).toBe('queued');
    expect(await cancellations(request.id)).toBe(0);
  }, 60_000);

  it('answers 404 for another organization and for an unknown request, and changes nothing', async () => {
    const { principal, request } = await queued();
    const elsewhere = `tenant-${randomUUID().slice(0, 8)}`;
    const outsider = await member('outsider', ['clinician'], elsewhere);

    expect(await refusal(service.cancel(as(outsider.sub, ['clinician'], elsewhere), request.id))).toEqual({ status: 404, reason: undefined });
    expect(await refusal(service.cancel(principal, randomUUID()))).toEqual({ status: 404, reason: undefined });
    expect(await jobState(request.jobId)).toBe('queued');
  }, 60_000);

  it('reads a job an operator cancelled (the jobs CLI) as cancelled, with no person recorded', async () => {
    const { principal, request } = await queued();
    await lab.row(`UPDATE jobs SET state = 'cancelled', finished_at = now(), updated_at = now() WHERE id = $1 AND state IN ('queued', 'retry')`, [request.jobId]);

    expect((await service.get(principal, request.id)).state).toBe('cancelled');
    expect(await cancellations(request.id)).toBe(0);
  }, 60_000);

  it('lets a cancel and a claim race: in every round exactly one of them wins, decided by the row lock', async () => {
    const outcomes = { cancelled: 0, claimed: 0 };
    for (let round = 0; round < 12; round++) {
      const { principal, request } = await queued();
      const [cancel, claimed] = await Promise.all([
        service.cancel(principal, request.id).then(
          () => 'ok' as const,
          (e: unknown) => e,
        ),
        claim(`w-race-${round}`, request.jobId),
      ]);
      const state = await jobState(request.jobId);
      if (cancel === 'ok') {
        expect(claimed).toBeUndefined();
        expect(state).toBe('cancelled');
        expect(await cancellations(request.id)).toBe(1);
        outcomes.cancelled++;
      } else {
        expect(cancel).toBeInstanceOf(AppException);
        expect((cancel as AppException).getStatus()).toBe(409);
        expect(claimed?.id).toBe(request.jobId);
        expect(state).toBe('running');
        expect(await cancellations(request.id)).toBe(0);
        outcomes.claimed++;
      }
      if (claimed) await queue.release(claimed.id, `w-race-${round}`);
    }
    expect(outcomes.cancelled + outcomes.claimed).toBe(12);
    // Which side wins depends on scheduling; the split is printed so a run can show both were exercised (the invariant above holds either way).
    console.info(`cancel/claim race: ${outcomes.cancelled} cancelled, ${outcomes.claimed} claimed`);
  }, 180_000);

  describe('the database refuses a cancellation that did not come through the rules', () => {
    const asApp = <T>(tenantId: string, actor: string, work: (c: import('pg').PoolClient) => Promise<T>) => app.get(Database).withTenant(tenantId, work, { actor });

    it('refuses a record written for a request someone else queued, and keeps their job queued', async () => {
      const { request } = await queued();
      const colleague = await member('colleague', ['clinician']);
      await expect(
        asApp(lab.tenant, colleague.sub, (c) =>
          c.query('INSERT INTO evaluation_request_cancellations (request_id, tenant_id, cancelled_by) VALUES ($1, $2, $3)', [request.id, lab.tenant, colleague.sub]),
        ),
      ).rejects.toMatchObject({ code: '42501' });
      expect(await jobState(request.jobId)).toBe('queued');
    }, 60_000);

    it('refuses a record that names a person other than the one acting', async () => {
      const { principal, request } = await queued();
      await expect(
        asApp(lab.tenant, principal.sub, (c) =>
          c.query('INSERT INTO evaluation_request_cancellations (request_id, tenant_id, cancelled_by) VALUES ($1, $2, $3)', [request.id, lab.tenant, 'someone-else']),
        ),
      ).rejects.toMatchObject({ code: '42501' });
      expect(await jobState(request.jobId)).toBe('queued');
    }, 60_000);

    it("refuses a colleague calling the job helper directly, and lets the requester's own call through (control)", async () => {
      const { principal, request } = await queued();
      const colleague = await member('colleague', ['clinician']);
      await expect(asApp(lab.tenant, colleague.sub, (c) => c.query('SELECT evaluation_job_cancel($1, $2)', [request.jobId, request.id]))).rejects.toMatchObject({ code: '42501' });
      expect(await jobState(request.jobId)).toBe('queued');

      await asApp(lab.tenant, principal.sub, (c) => c.query('SELECT evaluation_job_cancel($1, $2)', [request.jobId, request.id]));
      expect(await jobState(request.jobId)).toBe('cancelled');
    }, 60_000);

    it('keeps a record once written: no update, delete or truncate', async () => {
      const { principal, request } = await queued();
      await service.cancel(principal, request.id);
      for (const sql of [
        `UPDATE evaluation_request_cancellations SET cancelled_by = 'someone-else' WHERE request_id = '${request.id}'`,
        `DELETE FROM evaluation_request_cancellations WHERE request_id = '${request.id}'`,
      ]) {
        await expect(asApp(lab.tenant, principal.sub, (c) => c.query(sql))).rejects.toThrow();
      }
      await expect(lab.row('TRUNCATE evaluation_request_cancellations')).rejects.toThrow();
      expect(await cancellations(request.id)).toBe(1);
    }, 60_000);

    it('gives the application no way to change a job directly', async () => {
      const { principal, request } = await queued();
      await expect(
        asApp(lab.tenant, principal.sub, (c) => c.query(`UPDATE jobs SET state = 'cancelled', finished_at = now() WHERE id = $1`, [request.jobId])),
      ).rejects.toMatchObject({
        code: '42501',
      });
      expect(await jobState(request.jobId)).toBe('queued');
    }, 60_000);
  });
});
