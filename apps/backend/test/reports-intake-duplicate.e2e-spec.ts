import { createHash, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { ReportsRepository } from '../src/storage/reports.repository';
import { createTestApp, usingPostgres } from './helpers/app';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from './helpers/database';
import { bearer, clinicianA } from './helpers/tokens';

// Audit U1: two API tasks receive the same upload at once. Each task keeps its own set of active uploads, so only the database decides who writes; the request that
// loses must not cancel the attempt the winner began. Two applications on one database stand for two tasks. Synthetic data only.
const sample = Buffer.from('{"synthetic":true,"values":[1,2,3]}');
const MIME = 'application/json';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

(usingPostgres() ? describe : describe.skip)('a duplicate upload on another API task (audit U1)', () => {
  let db: EphemeralDatabase;
  let first: NestExpressApplication;
  let second: NestExpressApplication;
  beforeAll(async () => {
    db = await createEphemeralDatabase();
    first = await createTestApp({ postgresUrl: db.appUrl, organizationIntake: true });
    second = await createTestApp({ postgresUrl: db.appUrl, organizationIntake: true });
  });
  afterAll(async () => {
    await first?.close();
    await second?.close();
    await db?.drop();
  });

  const attemptRow = (attemptId: string) =>
    withAdmin(
      db.adminUrl,
      async (c) => (await c.query('SELECT state, cancel_requested, writer IS NOT NULL AS held FROM report_upload_attempts WHERE id = $1', [attemptId])).rows[0],
    );

  it('refuses the loser with 409 and leaves the winner to finish and commit', async () => {
    const token = await clinicianA();
    const api = (app: NestExpressApplication) => request(app.getHttpServer());
    const patient = (
      await api(first)
        .post('/api/v1/patients')
        .set(bearer(token))
        .send({ label: `SYN-${randomUUID().slice(0, 8)}` })
        .expect(201)
    ).body.id as string;
    const reportId = (
      await api(first).post('/api/v1/reports').set(bearer(token)).send({ patientId: patient, type: 'structured', filename: 'sample.json', sizeBytes: sample.length }).expect(201)
    ).body.id as string;
    const state = (await api(first).get(`/api/v1/reports/${reportId}/upload-state`).set(bearer(token)).expect(200)).body;
    const attempt = (
      await api(first)
        .post(`/api/v1/reports/${reportId}/upload-attempts`)
        .set(bearer(token))
        .send({ requestId: randomUUID(), revision: state.revision, contentType: MIME, sha256: sha(sample) })
        .expect(201)
    ).body as { attemptId: string; revision: string };
    const put = (app: NestExpressApplication) =>
      api(app)
        .put(`/api/v1/reports/${reportId}/upload-attempts/${attempt.attemptId}/bytes`)
        .set(bearer(token))
        .set('X-Upload-Revision', attempt.revision)
        .set('Content-Type', MIME)
        .set('Content-Length', String(sample.length));

    // The winner begins and is still receiving its bytes.
    const winner = put(first);
    winner.write(sample.subarray(0, 10));
    for (let i = 0; i < 200 && (await attemptRow(attempt.attemptId)).state !== 'intaking'; i += 1) await new Promise((r) => setTimeout(r, 25));
    expect(await attemptRow(attempt.attemptId)).toEqual({ state: 'intaking', cancel_requested: false, held: true });

    // The loser read the attempt as declared just before the winner began (the window between two tasks), then lost the begin.
    const repository = second.get(ReportsRepository);
    const read = repository.findAttempt.bind(repository);
    jest.spyOn(repository, 'findAttempt').mockImplementationOnce(async (identity) => {
      const found = await read(identity);
      return found && { ...found, state: 'declared' };
    });
    await put(second).send(sample.toString('utf8')).expect(409);
    expect(await attemptRow(attempt.attemptId)).toEqual({ state: 'intaking', cancel_requested: false, held: true });

    winner.write(sample.subarray(10));
    const res = await new Promise<request.Response>((resolve, reject) => {
      winner.end((error, response) => (response ? resolve(response) : reject(error as Error)));
    });
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('committed');
    expect(await attemptRow(attempt.attemptId)).toMatchObject({ state: 'committed', cancel_requested: false });
  });
});
