import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp, usingPostgres } from './helpers/app';
import { createEphemeralDatabase } from './helpers/database';
import type { EphemeralDatabase } from './helpers/database';
import { bearer, clinicianA } from './helpers/tokens';

let app: NestExpressApplication;
let database: Promise<EphemeralDatabase | undefined> | undefined;
let startingApp: Promise<NestExpressApplication> | undefined;
const cancellation = new AbortController();
// Like intake fixtures, database preparation and API startup each retain the default five-second hook budget.
beforeAll(async () => {
  database = usingPostgres() ? createEphemeralDatabase({ signal: cancellation.signal }) : Promise.resolve(undefined);
  await database;
});
beforeAll(async () => {
  const pg = await database;
  cancellation.signal.throwIfAborted();
  startingApp = createTestApp({ ...(pg ? { postgresUrl: pg.appUrl, ownerUrl: pg.adminUrl } : {}), signal: cancellation.signal });
  app = await startingApp;
});
afterAll(async () => {
  cancellation.abort(new Error('Input-boundary fixture scope ended'));
  // Await pending ownership too: a timed-out hook does not cancel its setup promise.
  try {
    await (await startingApp)?.close();
  } finally {
    await (await database)?.drop();
  }
});

it('rejects unexpected query and body without changing a record; auth takes precedence', async () => {
  const api = () => request(app.getHttpServer());
  const token = bearer(await clinicianA());
  const created = await api().post('/api/v1/patients').set(token).send({ label: 'SYN-boundary' }).expect(201);
  const url = `/api/v1/patients/${created.body.id}`;
  await api().delete(url).send({ ignored: 'SYN-private' }).expect(401);
  for (const method of ['get', 'delete'] as const) {
    const res = await api()[method](url).set(token).send({ ignored: 'SYN-private' }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(res.body)).not.toContain('SYN-private');
  }
  await api()
    .delete(url + '?ignored=SYN-private')
    .set(token)
    .expect(400);
  await api().delete(url).set(token).set('Content-Type', 'text/plain').send('SYN-private').expect(400);
  await api().get(url).set(token).expect(200);
  await api().get('/api/v1/health?ignored=SYN-private').expect(400);
  await api().post('/api/v1/patients?ignored=SYN-private').set(token).send({ label: 'SYN-new' }).expect(400);
  const unknown = await api().post('/api/v1/patients').set(token).send({ label: 'SYN-new', 'SYN-private-key': 'SYN-private' }).expect(400);
  expect(JSON.stringify(unknown.body)).not.toContain('SYN-private');
  await api().delete(url).set(token).send({}).expect(204);
});
