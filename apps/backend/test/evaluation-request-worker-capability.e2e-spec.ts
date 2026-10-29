import { randomBytes, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Pool } from 'pg';
import { evaluationRequest, JobError, JobQueue, type ClaimedJob } from '@telesphoros/jobs';
import type { EvaluationExecutionProfile } from '@telesphoros/shared-types';
import type { Env } from '../src/config/env';
import { Database } from '../src/db/database';
import type { IssuedJobCapability } from '../src/issuer/capability-issuer.port';
import { startIssuer, type RunningIssuer } from '../src/issuer/issuer-app';
import { loadIssuerEnv } from '../src/issuer/issuer-env';
import { HttpJobCapabilityClient, type JobCapabilityAsk, type JobCapabilityClient } from '../src/issuer/job-capability-client';
import { EvaluationRequestConsumer } from '../src/lab-reports/evaluation-request-consumer';
import { EvaluationRequestsService } from '../src/lab-reports/evaluation-requests.service';
import { loadEvaluationWorkerConfig } from '../src/lab-reports/evaluation-worker-config';
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

/**
 * Spec 012 slice 3 (T033): the evaluation worker under issuer capabilities, on the real stack and a REAL issuer process (its own core, store and database
 * login, the job route of slice 2) with the public synthetic fixture D01. It runs on the PostgreSQL tier, so CI runs it; it does not need TEST_REAL_ISSUER,
 * which only points the API's guard at an issuer. Every case is asserted through the stored rows and the issuer's own issuance log.
 */
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

/** The real client, counted; `answer` lets a case change what the worker is told, to prove the worker checks it. */
class CountingClient implements JobCapabilityClient {
  calls = 0;
  constructor(
    private readonly real: JobCapabilityClient,
    private readonly answer: (issued: IssuedJobCapability) => IssuedJobCapability = (issued) => issued,
  ) {}
  async issue(ask: JobCapabilityAsk): Promise<IssuedJobCapability> {
    this.calls++;
    return this.answer(await this.real.issue(ask));
  }
}

(usingPostgres() ? describe : describe.skip)('the evaluation-request worker under issuer capabilities', () => {
  const key = randomBytes(32);
  let db: EphemeralDatabase;
  let app: NestExpressApplication;
  let issuer: RunningIssuer;
  let workerPool: Pool;
  let queue: JobQueue;
  let profile: EvaluationExecutionProfile;
  const reader = new WatchedReader();

  beforeAll(async () => {
    db = await createEphemeralDatabase();
    app = await createTestApp({ labReportPipeline: true, postgresUrl: db.appUrl, overrides: [{ provide: LAB_READER, useValue: reader }] });
    const issuerEnv = loadIssuerEnv({
      NODE_ENV: 'development',
      DATABASE_URL: db.issuerUrl,
      DATABASE_SSL: 'disable',
      COGNITO_ISSUER: 'http://127.0.0.1:9/syn-unused-issuer',
      COGNITO_APP_CLIENT_ID: 'syn-client',
      ISSUER_WORKER_KEY: key.toString('base64url'),
    });
    issuer = await startIssuer(issuerEnv, { host: '127.0.0.1', port: 0 });
    workerPool = new Pool({ connectionString: db.workerUrl, max: 4 });
    queue = new JobQueue(workerPool);
    profile = {
      version: 'evaluation-execution-profile/1',
      codeArtifactSha256: sha('synthetic code artifact'),
      executionManifestSha256: sha('synthetic self-hosted manifest'),
      knowledgeSetId: app.get<KnowledgeSet>(LAB_KNOWLEDGE).id,
      recordingsSha256: app.get(TextCaptureRunner).manifestSha256,
    };
  }, 90_000);
  afterAll(async () => {
    await issuer?.stop(1000);
    await workerPool?.end();
    await app?.close();
    await db?.drop();
  });
  beforeEach(() => {
    reader.whileReading = () => undefined;
  });

  const issuerUrl = () => `http://127.0.0.1:${issuer.port}`;
  const realClient = (options: { key?: Buffer; baseUrl?: string } = {}) =>
    new HttpJobCapabilityClient({ baseUrl: options.baseUrl ?? issuerUrl(), key: options.key ?? key, retryPauseMs: 1 });
  const consumer = (client: JobCapabilityClient) => new EvaluationRequestConsumer(app.get(Database), app.get(EvaluationsService), profile, client);
  const admissions = () => new EvaluationRequestsService(new EvaluationRequestsRepository(app.get(Database)), profile);

  /** A reviewed, linked D01 report in its own organization, and an admitted request for it. */
  async function admitted() {
    const lab = new LabPipeline(app, db.adminUrl);
    const setup = await lab.reviewedCapture(fixturePdf('D01'));
    const principal = { tenantId: lab.tenant, sub: setup.clinician.sub, roles: ['clinician' as const] };
    const { request } = await admissions().admit(principal, { requestId: randomUUID(), reportId: setup.reportId, captureId: setup.captureId, acceptanceId: setup.acceptanceId });
    return { lab, setup, request };
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

  const stored = async (lab: LabPipeline, reportId: string, requestId: string) => ({
    evaluations: await lab.count('evaluations', 'report_id = $1', [reportId]),
    completions: await lab.count('evaluation_request_completions', 'request_id = $1', [requestId]),
  });
  /** The issuer's own record of every answer for this job: issued, or refused with the database's code. */
  const issuances = (lab: LabPipeline, jobId: string) =>
    lab.row<{ sub: string | null; outcome: string; reason: string | null }>('SELECT sub, outcome, reason FROM capability_issuance_log WHERE request_id = $1 ORDER BY seq', [jobId]);
  const run = (client: JobCapabilityClient, job: ClaimedJob, workerId: string) => consumer(client).handle({ job, workerId, signal: new AbortController().signal });
  const failure = async (promise: Promise<unknown>) => {
    const error = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(JobError);
    return { code: (error as JobError).code, retryable: (error as JobError).retryable };
  };

  it('SC-001: completes D01 under a new capability for each transaction, each one issued for the requester (control)', async () => {
    const { lab, setup, request } = await admitted();
    const job = await claim('w-capable', request.jobId);
    const client = new CountingClient(realClient());

    await run(client, job, 'w-capable');

    expect(await stored(lab, setup.reportId, request.id)).toEqual({ evaluations: 1, completions: 1 });
    expect(client.calls).toBeGreaterThanOrEqual(2); // at least the read of the request and the storing transaction
    const log = await issuances(lab, request.jobId);
    expect(log).toHaveLength(client.calls);
    expect(log.every((row) => row.outcome === 'issued' && row.sub === setup.clinician.sub)).toBe(true);
    expect(await lab.count('tenant_capabilities', 'request_id = $1', [request.jobId])).toBe(client.calls); // one capability per transaction, none reused
    expect((await admissions().get({ tenantId: lab.tenant, sub: setup.clinician.sub, roles: ['clinician'] }, request.id)).state).toBe('completed');
  }, 90_000);

  it.each([
    [
      'US2.1: a requester removed after queuing',
      (lab: LabPipeline, sub: string) => lab.row(`UPDATE tenant_memberships SET status = 'removed' WHERE tenant_id = $1 AND sub = $2`, [lab.tenant, sub]),
      'membership-not-current',
      'requester-not-authorized',
    ],
    [
      'US2.2: a requester who is now only a reader',
      (lab: LabPipeline, sub: string) => lab.row(`UPDATE tenant_memberships SET roles = '{reader}' WHERE tenant_id = $1 AND sub = $2`, [lab.tenant, sub]),
      'role-not-allowed',
      'requester-not-authorized',
    ],
    [
      'US2.3: a suspended organization',
      (lab: LabPipeline) => lab.row(`UPDATE tenants SET status = 'suspended', changed_by = 'syn-operator' WHERE id = $1`, [lab.tenant]),
      'tenant-inactive',
      'tenant-inactive',
    ],
  ])(
    'SC-002, %s: the issuer refuses and logs it, the job ends with a code, nothing is read or stored',
    async (_case, change, refusal, code) => {
      const { lab, setup, request } = await admitted();
      const job = await claim('w-refused', request.jobId);
      await change(lab, setup.clinician.sub);
      const readsBefore = reader.reads;

      expect(await failure(run(realClient(), job, 'w-refused'))).toEqual({ code, retryable: false });

      expect(reader.reads).toBe(readsBefore);
      expect(await stored(lab, setup.reportId, request.id)).toEqual({ evaluations: 0, completions: 0 });
      expect(await issuances(lab, request.jobId)).toEqual([expect.objectContaining({ outcome: 'refused', reason: refusal })]);
    },
    90_000,
  );

  it('US2.4: stores nothing when the requester is removed while the read runs; the storing transaction is refused its capability', async () => {
    const { lab, setup, request } = await admitted();
    const job = await claim('w-mid-read', request.jobId);
    reader.whileReading = async () => {
      await lab.row(`UPDATE tenant_memberships SET status = 'removed' WHERE tenant_id = $1 AND sub = $2`, [lab.tenant, setup.clinician.sub]);
    };

    expect(await failure(run(realClient(), job, 'w-mid-read'))).toEqual({ code: 'requester-not-authorized', retryable: false });

    expect(await stored(lab, setup.reportId, request.id)).toEqual({ evaluations: 0, completions: 0 });
    const log = await issuances(lab, request.jobId);
    expect(log.at(-1)).toEqual(expect.objectContaining({ outcome: 'refused', reason: 'membership-not-current' }));
    expect(log.slice(0, -1).every((row) => row.outcome === 'issued')).toBe(true);
  }, 90_000);

  it('a worker whose lease was lost is refused by the issuer before reading, and the new holder completes', async () => {
    const { lab, setup, request } = await admitted();
    const stale = await claim('w-stale', request.jobId);
    await lab.row(`UPDATE jobs SET lease_until = now() - interval '1 second' WHERE id = $1`, [request.jobId]);
    const fresh = await claim('w-fresh', request.jobId);
    const readsBefore = reader.reads;

    expect(await failure(run(realClient(), stale, 'w-stale'))).toEqual({ code: 'job-not-held', retryable: false });
    expect(reader.reads).toBe(readsBefore);
    expect(await issuances(lab, request.jobId)).toEqual([expect.objectContaining({ outcome: 'refused', reason: 'job-not-held' })]);

    await run(realClient(), fresh, 'w-fresh');
    expect(await stored(lab, setup.reportId, request.id)).toEqual({ evaluations: 1, completions: 1 });
  }, 90_000);

  it.each([
    ['names another person', (issued: IssuedJobCapability) => ({ ...issued, sub: 'syn-someone-else' })],
    ['names another organization', (issued: IssuedJobCapability) => ({ ...issued, tenantId: 'tenant-elsewhere' })],
  ])(
    'ends the job, storing nothing, when a capability %s than the job',
    async (_case, answer) => {
      const { lab, setup, request } = await admitted();
      const job = await claim('w-mismatch', request.jobId);

      expect(await failure(run(new CountingClient(realClient(), answer), job, 'w-mismatch'))).toEqual({ code: 'requester-not-authorized', retryable: false });
      expect(await stored(lab, setup.reportId, request.id)).toEqual({ evaluations: 0, completions: 0 });
    },
    90_000,
  );

  it.each([
    ['an issuer that cannot be reached', () => realClient({ baseUrl: 'http://127.0.0.1:9' }), 'issuer-unavailable'],
    ['a worker key the issuer does not hold', () => realClient({ key: randomBytes(32) }), 'issuer-unauthenticated'],
  ])(
    'retries the job, reading and storing nothing, for %s; the issuer logs no answer',
    async (_case, client, code) => {
      const { lab, setup, request } = await admitted();
      const job = await claim('w-retry', request.jobId);
      const readsBefore = reader.reads;

      expect(await failure(run(client(), job, 'w-retry'))).toEqual({ code, retryable: true });

      expect(reader.reads).toBe(readsBefore);
      expect(await stored(lab, setup.reportId, request.id)).toEqual({ evaluations: 0, completions: 0 });
      expect(await issuances(lab, request.jobId)).toEqual([]);
    },
    90_000,
  );

  // Limits are only counted today (0028 `enforce_limits`). Once enforced, a requester issued many capabilities lately is refused `rate-limited`: that says
  // nothing about whether they may have this one, so the job is retried, not ended for good.
  it('retries the job, storing nothing, when the issuer refuses a transaction as rate-limited, and completes once the limit allows', async () => {
    const { lab, setup, request } = await admitted();
    const job = await claim('w-limited', request.jobId);
    const [before] = await lab.row<{ burst_limit: number; enforce_limits: boolean }>(
      `SELECT burst_limit, enforce_limits FROM capability_purposes WHERE purpose = 'evaluation-job'`,
    );
    await lab.row(`UPDATE capability_purposes SET burst_limit = 1, enforce_limits = true WHERE purpose = 'evaluation-job'`);
    try {
      expect(await failure(run(realClient(), job, 'w-limited'))).toEqual({ code: 'issuer-rate-limited', retryable: true });
      expect(await stored(lab, setup.reportId, request.id)).toEqual({ evaluations: 0, completions: 0 });
      const log = await issuances(lab, request.jobId);
      expect(log[0]).toEqual(expect.objectContaining({ outcome: 'issued' })); // the first transaction was within the limit
      expect(log.at(-1)).toEqual(expect.objectContaining({ outcome: 'refused', reason: 'rate-limited' }));
    } finally {
      await lab.row(`UPDATE capability_purposes SET burst_limit = $1, enforce_limits = $2 WHERE purpose = 'evaluation-job'`, [before!.burst_limit, before!.enforce_limits]);
    }

    await run(realClient(), job, 'w-limited'); // the same worker still holds the job, as a retry would
    expect(await stored(lab, setup.reportId, request.id)).toEqual({ evaluations: 1, completions: 1 });
  }, 90_000);

  it('keeps refusing a worker without the issuer settings beside an API that uses the issuer (the guard, FR-006)', () => {
    const appEnv = { LAB_REPORT_PIPELINE: 'enabled', DATABASE_URL: db.appUrl, ISSUER_URL: issuerUrl() } as Env;
    const source = {
      EVALUATION_WORKER: 'enabled',
      EVALUATION_WORKER_DATABASE_URL: db.workerUrl,
      EVALUATION_EXECUTION_PROFILE: JSON.stringify(profile),
      WORKER_ID: 'evaluation-1',
    };
    expect(() => loadEvaluationWorkerConfig(appEnv, source)).toThrow(/EVALUATION_WORKER is refused while ISSUER_URL is set/);
    const configured = loadEvaluationWorkerConfig(appEnv, { ...source, EVALUATION_WORKER_ISSUER_URL: issuerUrl(), EVALUATION_WORKER_ISSUER_KEY: key.toString('base64url') });
    expect(configured.issuer?.baseUrl).toBe(issuerUrl());
  });
});
