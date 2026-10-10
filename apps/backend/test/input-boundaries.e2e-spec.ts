import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp } from './helpers/app';
import { bearer, clinicianA } from './helpers/tokens';

let app: NestExpressApplication;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
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
