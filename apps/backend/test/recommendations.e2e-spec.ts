import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp } from './helpers/app';
import { bearer, clinicianA, readerA } from './helpers/tokens';

let app: NestExpressApplication;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
});

const api = () => request(app.getHttpServer());
const BASE = '/api/v1/recommendations';

/**
 * The single-gene recommendations route was retired: nothing in production ever wrote the table behind it, so it could
 * only answer "none" for a patient who may have evaluated results. Recommendations are read from evaluations.
 * This pins the retirement, so a route cannot come back under this path without this test being rewritten on purpose.
 */
describe('the retired /recommendations route', () => {
  it.each([
    ['GET list', () => api().get(BASE)],
    ['GET by id', () => api().get(`${BASE}/${randomUUID()}`)],
    ['POST', () => api().post(BASE)],
    ['PUT', () => api().put(`${BASE}/${randomUUID()}`)],
    ['PATCH', () => api().patch(`${BASE}/${randomUUID()}`)],
    ['DELETE', () => api().delete(`${BASE}/${randomUUID()}`)],
  ])('%s answers 404 NOT_FOUND for a signed-in clinician', async (_name, call) => {
    const res = await call().set(bearer(await clinicianA())).send({ gene: 'X' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('answers 404 for a reader too, not 403, because there is no route to protect (control: a live clinical read still answers 200)', async () => {
    const reader = bearer(await readerA());
    expect((await api().get(BASE).set(reader)).status).toBe(404);
    expect((await api().get('/api/v1/patients').set(reader)).status).toBe(200);
  });
});
