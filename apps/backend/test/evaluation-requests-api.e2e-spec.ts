import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Pool } from 'pg';
import { evaluationRequest, JobQueue, type ClaimedJob } from '@telesphoros/jobs';
import { evaluationRequestDtoSchema, type EvaluationExecutionProfile } from '@telesphoros/shared-types';
import { Database } from '../src/db/database';
import { EvaluationRequestConsumer } from '../src/lab-reports/evaluation-request-consumer';
import { EVALUATION_REQUESTS_SERVICE } from '../src/lab-reports/evaluation-requests-switch';
import { EvaluationsService } from '../src/lab-reports/evaluations.service';
import { createTestApp, usingPostgres } from './helpers/app';
import { createEphemeralDatabase, type EphemeralDatabase } from './helpers/database';
import { fixturePdf, LabPipeline, sha, syntheticExecutionProfile } from './helpers/lab-pipeline';
import { bearer } from './helpers/tokens';

// H4 slice 1: the queued path through HTTP, on the real stack (migrations, roles, row-level security, the queue, ledger and storage) with the public
// synthetic fixture D01. Admission and status are H1's; this proves the routes add the gate, the roles and the status codes, and nothing else.
const JOBS = `type = '${evaluationRequest.type}'`;

(usingPostgres() ? describe : describe.skip)('queued evaluation requests over HTTP (H4)', () => {
  let db: EphemeralDatabase;
  let profile: EvaluationExecutionProfile;

  beforeAll(async () => {
    db = await createEphemeralDatabase();
    profile = await syntheticExecutionProfile();
  }, 60_000);
  afterAll(async () => {
    await db?.drop();
  });

  describe('switched on', () => {
    let app: NestExpressApplication;
    let lab: LabPipeline;
    let workerPool: Pool;
    let queue: JobQueue;

    beforeAll(async () => {
      app = await createTestApp({ labReportPipeline: true, evaluationRequests: JSON.stringify(profile), postgresUrl: db.appUrl });
      lab = new LabPipeline(app, db.adminUrl);
      workerPool = new Pool({ connectionString: db.workerUrl, max: 2 });
      queue = new JobQueue(workerPool);
    }, 60_000);
    afterAll(async () => {
      await workerPool?.end();
      await app?.close();
    });

    const admit = (token: string, reportId: string, body: object) => lab.api().post(`/api/v1/reports/${reportId}/evaluation-requests`).set(bearer(token)).send(body);
    const status = (token: string, id: string) => lab.api().get(`/api/v1/evaluation-requests/${id}`).set(bearer(token));
    const jobs = () => lab.count('jobs', `${JOBS} AND tenant_id = $1`, [lab.tenant]);

    async function reviewed() {
      const setup = await lab.reviewedCapture(fixturePdf('D01'));
      return { setup, body: { captureId: setup.captureId, acceptanceId: setup.acceptanceId, requestId: randomUUID() } };
    }

    it('answers 202 with a queued request and one job, and an identical replay answers 200 with the same request and no second job', async () => {
      const { setup, body } = await reviewed();
      const before = await jobs();

      const first = await admit(setup.clinician.token, setup.reportId, body).expect(202);
      const request = evaluationRequestDtoSchema.parse(first.body);
      expect(request).toMatchObject({ reportId: setup.reportId, captureId: setup.captureId, acceptanceId: setup.acceptanceId, state: 'queued', evaluationId: null });
      expect(await jobs()).toBe(before + 1);

      const replay = await admit(setup.clinician.token, setup.reportId, body).expect(200);
      expect(replay.body).toMatchObject({ id: request.id, jobId: request.jobId });
      expect(await jobs()).toBe(before + 1);
    }, 60_000);

    it('refuses the same request id for a different capture (409) and queues nothing', async () => {
      const { setup, body } = await reviewed();
      await admit(setup.clinician.token, setup.reportId, body).expect(202);
      const other = await lab.reviewedCapture(fixturePdf('D01'), { clinician: setup.clinician });
      const before = await jobs();

      const changed = await admit(setup.clinician.token, other.reportId, { ...body, captureId: other.captureId, acceptanceId: other.acceptanceId }).expect(409);
      expect(changed.body.error.details).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'idempotency-conflict' })]));
      expect(await jobs()).toBe(before);
    }, 60_000);

    it('lets a clinician or a reviewer queue, and refuses a reader (403) with nothing queued', async () => {
      const { setup, body } = await reviewed();
      const reader = await lab.person('reader', ['reader']);
      const before = await jobs();

      await admit(reader.token, setup.reportId, body).expect(403);
      expect(await jobs()).toBe(before);

      const reviewer = await lab.person('rev2', ['reviewer']);
      await admit(reviewer.token, setup.reportId, body).expect(202);
      expect(await jobs()).toBe(before + 1);
    }, 60_000);

    it('lets anyone with a clinical-read role read a request, answers 404 to another organization, and 400 to a malformed id', async () => {
      const { setup, body } = await reviewed();
      const { body: created } = await admit(setup.clinician.token, setup.reportId, body).expect(202);
      const reader = await lab.person('reader', ['reader']);

      const read = await status(reader.token, created.id).expect(200);
      expect(evaluationRequestDtoSchema.parse(read.body)).toMatchObject({ id: created.id, state: 'queued' });

      const outsider = await lab.person('clin', ['clinician'], `tenant-${randomUUID().slice(0, 8)}`);
      await status(outsider.token, created.id).expect(404);
      await status(setup.clinician.token, randomUUID()).expect(404);
      await status(setup.clinician.token, 'not-a-uuid').expect(400);
    }, 60_000);

    it.each([
      ['an unknown field', { provider: 'bedrock' }],
      ['a profile', { profile: { version: 'evaluation-execution-profile/1' } }],
      ['a report id in the body', { reportId: randomUUID() }],
    ])(
      'refuses a body with %s (400) and queues nothing',
      async (_name, extra) => {
        const { setup, body } = await reviewed();
        const before = await jobs();
        await admit(setup.clinician.token, setup.reportId, { ...body, ...extra }).expect(400);
        await admit(setup.clinician.token, setup.reportId, { captureId: body.captureId, acceptanceId: body.acceptanceId }).expect(400);
        expect(await jobs()).toBe(before);
      },
      60_000,
    );

    it('reads as completed once the H3 worker answers it, and the evaluation it names can be read', async () => {
      const { setup, body } = await reviewed();
      const { body: created } = await admit(setup.clinician.token, setup.reportId, body).expect(202);

      let job: ClaimedJob | undefined;
      for (let i = 0; i < 20 && !job; i++) {
        const claimed = await queue.claim('w-h4', { types: [evaluationRequest.type], batch: 10, tenantCap: 50, leaseSeconds: 60 });
        job = claimed.find((j) => j.id === created.jobId);
        for (const other of claimed.filter((j) => j !== job)) await queue.release(other.id, 'w-h4');
      }
      if (!job) throw new Error('The job was not claimed.');
      await new EvaluationRequestConsumer(app.get(Database), app.get(EvaluationsService), profile).handle({ job, workerId: 'w-h4', signal: new AbortController().signal });

      const done = evaluationRequestDtoSchema.parse((await status(setup.clinician.token, created.id).expect(200)).body);
      expect(done.state).toBe('completed');
      const evaluation = await lab.api().get(`/api/v1/evaluations/${done.evaluationId}`).set(bearer(setup.clinician.token)).expect(200);
      expect(evaluation.body).toMatchObject({ id: done.evaluationId, reportId: setup.reportId });
    }, 60_000);
  });

  describe('switched off (the default), with the pipeline on', () => {
    let app: NestExpressApplication;
    let lab: LabPipeline;

    beforeAll(async () => {
      app = await createTestApp({ labReportPipeline: true, postgresUrl: db.appUrl });
      lab = new LabPipeline(app, db.adminUrl);
    }, 60_000);
    afterAll(async () => {
      await app?.close();
    });

    it('has no admission service, answers 503 to both routes, and queues nothing', async () => {
      expect(app.get(EVALUATION_REQUESTS_SERVICE, { strict: false })).toBeUndefined();
      const setup = await lab.reviewedCapture(fixturePdf('D01'));
      const before = await lab.count('jobs', JOBS);

      const post = await lab
        .api()
        .post(`/api/v1/reports/${setup.reportId}/evaluation-requests`)
        .set(bearer(setup.clinician.token))
        .send({ captureId: setup.captureId, acceptanceId: setup.acceptanceId, requestId: randomUUID() })
        .expect(503);
      expect(post.body.error.code).toBe('EVALUATION_REQUESTS_DISABLED');
      const get = await lab.api().get(`/api/v1/evaluation-requests/${randomUUID()}`).set(bearer(setup.clinician.token)).expect(503);
      expect(get.body.error.code).toBe('EVALUATION_REQUESTS_DISABLED');
      // The gate answers before the body is read: an invalid body still hears 503, not 400 (the controller's own fallback could not tell these apart).
      const invalid = await lab.api().post(`/api/v1/reports/${setup.reportId}/evaluation-requests`).set(bearer(setup.clinician.token)).send({ bad: true }).expect(503);
      expect(invalid.body.error.code).toBe('EVALUATION_REQUESTS_DISABLED');
      expect(await lab.count('jobs', JOBS)).toBe(before);
    }, 60_000);

    it('still answers 401 and 403 before 503: who may not use a route learns nothing about the switch', async () => {
      const reader = await lab.person('reader', ['reader']);
      const id = randomUUID();
      await lab.api().post(`/api/v1/reports/${id}/evaluation-requests`).send({}).expect(401);
      await lab.api().post(`/api/v1/reports/${id}/evaluation-requests`).set(bearer(reader.token)).send({}).expect(403);
    }, 60_000);
  });

  it('refuses to start when the profile names a knowledge set the API did not load', async () => {
    const wrong = { ...profile, knowledgeSetId: sha('a knowledge set this app did not load') };
    await expect(createTestApp({ labReportPipeline: true, evaluationRequests: JSON.stringify(wrong), postgresUrl: db.appUrl })).rejects.toThrow(/knowledge set/);
  }, 60_000);

  it('refuses to start when the profile names recordings the API did not load', async () => {
    const wrong = { ...profile, recordingsSha256: sha('recordings this app did not load') };
    await expect(createTestApp({ labReportPipeline: true, evaluationRequests: JSON.stringify(wrong), postgresUrl: db.appUrl })).rejects.toThrow(/recordings/);
  }, 60_000);
});
