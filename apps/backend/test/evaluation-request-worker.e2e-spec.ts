import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Client, Pool } from 'pg';
import { evaluationRequest, JobError, JobQueue, Runner, type ClaimedJob } from '@telesphoros/jobs';
import type { EvaluationExecutionProfile } from '@telesphoros/shared-types';
import { Database } from '../src/db/database';
import { EvaluationRequestConsumer, evaluationRequestJob } from '../src/lab-reports/evaluation-request-consumer';
import { EvaluationRequestsService } from '../src/lab-reports/evaluation-requests.service';
import { EvaluationsService, LAB_KNOWLEDGE, LAB_READER } from '../src/lab-reports/evaluations.service';
import { TextCaptureRunner } from '../src/lab-reports/runner/text-capture-runner';
import type { KnowledgeSet } from '../src/services/knowledge/knowledge-set';
import type { ReaderResult } from '../src/services/report-reader/reader-result';
import type { ReportReader } from '../src/services/report-reader/report-reader';
import { EvaluationRequestsRepository } from '../src/storage/postgres/evaluation-requests.repository';
import { createTestApp, usingPostgres } from './helpers/app';
import { createEphemeralDatabase, type EphemeralDatabase } from './helpers/database';
import { fixturePdf, LabPipeline, sha } from './helpers/lab-pipeline';
import { StandInReportReader } from './helpers/stand-in-reader';
import { bearer } from './helpers/tokens';

// H3: the evaluation-request consumer, on the real stack (migrations, roles, row-level security, the real queue functions, ledger and storage) with the public
// synthetic fixture D01. The reader is the test stand-in, wrapped so a test can act while it reads. Everything is asserted through the queue, the request's
// public status and the stored rows. A worker that no longer holds its job must store nothing, and a completion is stored with its evaluation or not at all.
class WatchedReader implements ReportReader {
  private readonly standIn = new StandInReportReader();
  reads = 0;
  whileReading: () => Promise<void> | void = () => undefined;

  async read(text: string): Promise<ReaderResult> {
    this.reads++;
    await this.whileReading();
    return this.standIn.read(text);
  }
}

(usingPostgres() ? describe : describe.skip)('the evaluation-request worker', () => {
  let db: EphemeralDatabase;
  let app: NestExpressApplication;
  let lab: LabPipeline;
  let workerPool: Pool;
  let queue: JobQueue;
  let profile: EvaluationExecutionProfile;
  const reader = new WatchedReader();

  beforeAll(async () => {
    db = await createEphemeralDatabase();
    app = await createTestApp({ labReportPipeline: true, postgresUrl: db.appUrl, overrides: [{ provide: LAB_READER, useValue: reader }] });
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
  }, 60_000);
  afterAll(async () => {
    await workerPool?.end();
    await app?.close();
    await db?.drop();
  });
  beforeEach(() => {
    reader.whileReading = () => undefined;
  });

  const consumer = (workerProfile = profile) => new EvaluationRequestConsumer(app.get(Database), app.get(EvaluationsService), workerProfile);
  const admissions = (requestProfile = profile) => new EvaluationRequestsService(new EvaluationRequestsRepository(app.get(Database)), requestProfile);

  /** A reviewed, linked D01 report and an admitted request for it; returns the request and who asked. */
  async function admitted(requestProfile = profile, local = lab) {
    const setup = await local.reviewedCapture(fixturePdf('D01'));
    const principal = { tenantId: local.tenant, sub: setup.clinician.sub, roles: ['clinician' as const] };
    const { request } = await admissions(requestProfile).admit(principal, {
      requestId: randomUUID(),
      reportId: setup.reportId,
      captureId: setup.captureId,
      acceptanceId: setup.acceptanceId,
    });
    return { setup, principal, request };
  }

  async function claim(workerId: string, jobId: string): Promise<ClaimedJob> {
    for (let i = 0; i < 20; i++) {
      const jobs = await queue.claim(workerId, { types: [evaluationRequest.type], batch: 10, tenantCap: 50, leaseSeconds: 60 });
      const mine = jobs.find((j) => j.id === jobId);
      for (const other of jobs.filter((j) => j !== mine)) await queue.release(other.id, workerId);
      if (mine) return mine;
    }
    throw new Error('The job was not claimed.');
  }

  /** What another worker sees after the lease of `jobId` ran out: the job is claimed again, by `workerId`. */
  async function leaseLostTo(workerId: string, jobId: string): Promise<ClaimedJob> {
    await lab.row(`UPDATE jobs SET lease_until = now() - interval '1 second' WHERE id = $1`, [jobId]);
    return claim(workerId, jobId);
  }

  const stored = async (reportId: string, requestId: string) => ({
    evaluations: await lab.count('evaluations', 'report_id = $1', [reportId]),
    completions: await lab.count('evaluation_request_completions', 'request_id = $1', [requestId]),
  });
  const run = (job: ClaimedJob, workerId: string, signal = new AbortController().signal, workerProfile = profile) => consumer(workerProfile).handle({ job, workerId, signal });
  const failure = async (promise: Promise<unknown>) => {
    const error = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(JobError);
    return { code: (error as JobError).code, retryable: (error as JobError).retryable };
  };

  it('stores one evaluation and its completion while the worker holds the job, and the request reads as completed', async () => {
    const { setup, principal, request } = await admitted();
    const job = await claim('w-held', request.jobId);

    await run(job, 'w-held');

    expect(await stored(setup.reportId, request.id)).toEqual({ evaluations: 1, completions: 1 });
    const status = await admissions().get(principal, request.id);
    expect(status.state).toBe('completed');
    expect(status.evaluationId).toEqual(expect.any(String));
    const [receipt] = await lab.row<{ job_id: string; worker_id: string }>('SELECT job_id::text, worker_id FROM evaluation_request_completions WHERE request_id = $1', [
      request.id,
    ]);
    expect(receipt).toEqual({ job_id: request.jobId, worker_id: 'w-held' });
  }, 60_000);

  it('stores the evaluation without building the response the worker never reads', async () => {
    const { setup, request } = await admitted();
    const job = await claim('w-no-response', request.jobId);
    const present = jest.spyOn(app.get(EvaluationsService) as unknown as { present: () => Promise<unknown> }, 'present');
    try {
      await run(job, 'w-no-response');
      expect(present).not.toHaveBeenCalled();
    } finally {
      present.mockRestore();
    }
    expect(await stored(setup.reportId, request.id)).toEqual({ evaluations: 1, completions: 1 });
  }, 60_000);

  it('refuses a worker whose lease was lost before it started, without reading, and the new holder completes', async () => {
    const { setup, request } = await admitted();
    const stale = await claim('w-stale', request.jobId);
    const fresh = await leaseLostTo('w-fresh', request.jobId);
    const readsBefore = reader.reads;

    expect(await failure(run(stale, 'w-stale'))).toEqual({ code: 'lease-lost', retryable: true });
    expect(reader.reads).toBe(readsBefore);
    expect(await stored(setup.reportId, request.id)).toEqual({ evaluations: 0, completions: 0 });

    await run(fresh, 'w-fresh');
    expect(await stored(setup.reportId, request.id)).toEqual({ evaluations: 1, completions: 1 });
  }, 60_000);

  it('stores nothing when the lease is lost while the reader runs', async () => {
    const { setup, request } = await admitted();
    const stale = await claim('w-slow', request.jobId);
    let fresh: ClaimedJob | undefined;
    reader.whileReading = async () => {
      reader.whileReading = () => undefined;
      fresh = await leaseLostTo('w-next', request.jobId);
    };

    expect(await failure(run(stale, 'w-slow'))).toEqual({ code: 'lease-lost', retryable: true });
    expect(await stored(setup.reportId, request.id)).toEqual({ evaluations: 0, completions: 0 });

    await run(fresh!, 'w-next');
    expect(await stored(setup.reportId, request.id)).toEqual({ evaluations: 1, completions: 1 });
  }, 60_000);

  it('stores nothing when the lease ran out during the read, even before any other worker claims the job', async () => {
    const { setup, request } = await admitted();
    const job = await claim('w-expired', request.jobId);
    reader.whileReading = async () => {
      await lab.row(`UPDATE jobs SET lease_until = now() - interval '1 second' WHERE id = $1`, [request.jobId]);
    };

    expect(await failure(run(job, 'w-expired'))).toEqual({ code: 'lease-lost', retryable: true });
    expect(await stored(setup.reportId, request.id)).toEqual({ evaluations: 0, completions: 0 });
  }, 60_000);

  it('keeps the job from being claimed again while a storing transaction holds it, even past its lease', async () => {
    const { request } = await admitted();
    await claim('w-storing', request.jobId);
    await lab.row(`UPDATE jobs SET lease_until = clock_timestamp() + interval '1 second' WHERE id = $1`, [request.jobId]);
    const storing = new Client({ connectionString: db.appUrl });
    await storing.connect();
    try {
      await storing.query('BEGIN');
      await storing.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [lab.tenant]);
      await storing.query('SELECT evaluation_job_fence($1, $2)', [request.jobId, 'w-storing']);
      await new Promise((r) => setTimeout(r, 1500)); // the lease runs out while the transaction is open

      const taken = await queue.claim('w-thief', { types: [evaluationRequest.type], batch: 10, tenantCap: 50, leaseSeconds: 60 });
      for (const other of taken) await queue.release(other.id, 'w-thief');
      expect(taken.map((j) => j.id)).not.toContain(request.jobId);
    } finally {
      await storing.query('ROLLBACK');
      await storing.end();
    }
    expect((await claim('w-after', request.jobId)).id).toBe(request.jobId); // once it ends, the expired lease can be taken over as usual
  }, 60_000);

  it('stores neither the evaluation nor the completion when the requester loses access while the reader runs', async () => {
    const { setup, request } = await admitted();
    const job = await claim('w-revoked', request.jobId);
    reader.whileReading = async () => {
      await lab.row(`UPDATE tenant_memberships SET status = 'removed' WHERE tenant_id = $1 AND sub = $2`, [lab.tenant, setup.clinician.sub]);
    };

    expect(await failure(run(job, 'w-revoked'))).toEqual({ code: 'requester-not-authorized', retryable: false });
    expect(await stored(setup.reportId, request.id)).toEqual({ evaluations: 0, completions: 0 });
  }, 60_000);

  it('completes a redelivered job without reading again or storing a second evaluation', async () => {
    const { setup, request } = await admitted();
    const first = await claim('w-first', request.jobId);
    await run(first, 'w-first');
    const again = await leaseLostTo('w-again', request.jobId); // as if the first worker died before reporting success
    const readsBefore = reader.reads;

    await run(again, 'w-again');

    expect(reader.reads).toBe(readsBefore);
    expect(await stored(setup.reportId, request.id)).toEqual({ evaluations: 1, completions: 1 });
  }, 60_000);

  it('refuses, without reading, a request pinned to an execution profile this worker does not run', async () => {
    const { setup, request } = await admitted({ ...profile, executionManifestSha256: sha('a different manifest') });
    const job = await claim('w-profile', request.jobId);
    const readsBefore = reader.reads;

    expect(await failure(run(job, 'w-profile'))).toEqual({ code: 'execution-profile-mismatch', retryable: false });
    expect(reader.reads).toBe(readsBefore);
    expect(await stored(setup.reportId, request.id)).toEqual({ evaluations: 0, completions: 0 });
  }, 60_000);

  it('stores nothing when the job is aborted while the reader runs (timeout, lost lease or shutdown)', async () => {
    const { setup, request } = await admitted();
    const job = await claim('w-abort', request.jobId);
    const controller = new AbortController();
    reader.whileReading = () => controller.abort(new Error('timeout'));

    expect(await failure(run(job, 'w-abort', controller.signal))).toEqual({ code: 'handler-aborted', retryable: true });
    expect(await stored(setup.reportId, request.id)).toEqual({ evaluations: 0, completions: 0 });
  }, 60_000);

  it('runs under the shared job runner: claim, evaluate, complete, succeed', async () => {
    const { setup, principal, request } = await admitted();
    const runner = new Runner({
      workerId: 'w-runner',
      queue,
      jobs: [evaluationRequestJob(consumer())],
      concurrency: 1,
      tenantCap: 50,
      pollMs: 50,
      drainSeconds: 1,
      log: () => undefined,
    });
    runner.start();
    try {
      for (let i = 0; i < 200 && (await admissions().get(principal, request.id)).state !== 'completed'; i++) await new Promise((r) => setTimeout(r, 50));
    } finally {
      await runner.stop();
    }
    expect(await stored(setup.reportId, request.id)).toEqual({ evaluations: 1, completions: 1 });
    const [job] = await lab.row<{ state: string }>('SELECT state FROM jobs WHERE id = $1', [request.jobId]);
    expect(job!.state).toBe('succeeded');
  }, 60_000);

  it('reads a request completed under an active dispute as completed: the overlay changes the effective set, not the base set it pinned', async () => {
    // Its own organization: a dispute applies to every later evaluation in the organization that raised it.
    const disputed = new LabPipeline(app, db.adminUrl);
    const first = await disputed.reviewedCapture(fixturePdf('D01'));
    const shown = (await disputed.evaluate(first.clinician, first.reportId, { captureId: first.captureId, acceptanceId: first.acceptanceId }).expect(201)).body;
    const cited = shown.results.find((r: { drug: string }) => r.drug === 'drugq').citation;
    const cell = {
      guidelineId: cited.guidelineId,
      locator: { table: cited.locator.table, row: cited.locator.row, ...(cited.locator.column ? { column: cited.locator.column } : {}) },
    };
    await disputed
      .api()
      .post('/api/v1/cell-disputes')
      .set(bearer(first.reviewer.token))
      .send({ ...cell, note: 'SYN: x' })
      .expect(201);
    const { principal, request } = await admitted(profile, disputed);

    await run(await claim('w-overlay', request.jobId), 'w-overlay');

    const [evaluation] = await lab.row<{ id: string; knowledge_set_id: string; base: string }>(
      `SELECT e.id::text, e.knowledge_set_id, e.binding -> 'overlay' ->> 'baseKnowledgeSetId' AS base
         FROM evaluation_request_completions c JOIN evaluations e ON e.id = c.evaluation_id WHERE c.request_id = $1`,
      [request.id],
    );
    expect(evaluation!.knowledge_set_id).not.toBe(profile.knowledgeSetId); // control: the overlay really applied
    expect(evaluation!.base).toBe(profile.knowledgeSetId);
    expect(await admissions().get(principal, request.id)).toMatchObject({ state: 'completed', evaluationId: evaluation!.id });
  }, 60_000);

  describe('the database fence on a completion, for any caller', () => {
    /** One application transaction bound to `tenant` and acting as `actor`, as the repositories open them. */
    async function asApp<T>(tenant: string, actor: string, work: (c: Client) => Promise<T>): Promise<T> {
      const client = new Client({ connectionString: db.appUrl });
      await client.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.current_tenant_id', $1, true), set_config('app.current_actor', $2, true)`, [tenant, actor]);
        return await work(client);
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        await client.end();
      }
    }
    const refusal = (promise: Promise<unknown>) =>
      promise.then(
        () => 'stored',
        (e: { code?: string }) => e.code,
      );
    const insert = (c: Client, row: { tenant: string; request: string; evaluation: string; job: string; worker: string }) =>
      c.query('INSERT INTO evaluation_request_completions (request_id, tenant_id, evaluation_id, job_id, worker_id) VALUES ($1,$2,$3,$4,$5)', [
        row.request,
        row.tenant,
        row.evaluation,
        row.job,
        row.worker,
      ]);
    /** A completed request in this tenant, for its evaluation id, and a second request whose job `w-sql` now holds. */
    async function heldBeside() {
      const done = await admitted();
      await run(await claim('w-done', done.request.jobId), 'w-done');
      const [evaluation] = await lab.row<{ id: string }>('SELECT id::text FROM evaluations WHERE report_id = $1', [done.setup.reportId]);
      const open = await admitted();
      await claim('w-sql', open.request.jobId);
      return { evaluationId: evaluation!.id, open };
    }

    it('refuses a completion from a worker that does not hold the job, and one naming another report’s evaluation', async () => {
      const { evaluationId, open } = await heldBeside();
      const row = { tenant: lab.tenant, request: open.request.id, evaluation: evaluationId, job: open.request.jobId };
      await asApp(lab.tenant, open.setup.clinician.sub, async (c) => {
        expect(await refusal(insert(c, { ...row, worker: 'w-not-holding' }))).toBe('EJ001');
      });
      await asApp(lab.tenant, open.setup.clinician.sub, async (c) => {
        expect(await refusal(insert(c, { ...row, worker: 'w-sql' }))).toBe('ER001');
      });
    }, 60_000);

    it('refuses a completion bound to another organization', async () => {
      const { evaluationId, open } = await heldBeside();
      const row = { tenant: lab.tenant, request: open.request.id, evaluation: evaluationId, job: open.request.jobId, worker: 'w-sql' };
      await asApp(`tenant-${randomUUID().slice(0, 8)}`, open.setup.clinician.sub, async (c) => {
        expect(await refusal(insert(c, row))).not.toBe('stored');
      });
    }, 60_000);
  });
});
