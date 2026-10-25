import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp } from './helpers/app';
import { bearer, clinicianA, readerA } from './helpers/tokens';

/**
 * E06 (research audit): authenticated clinical metadata, and every refusal around it, must not be stored by a browser or a shared cache.
 * The header is set once, before routing, so it also covers 401, 403, 404, 429 and parse errors that never reach a controller.
 */
const NO_STORE = 'private, no-store';
const MISSING_ID = '00000000-0000-4000-8000-000000000000';

let app: NestExpressApplication;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
});
const api = () => request(app.getHttpServer());

describe('Cache-Control on authenticated and refused responses', () => {
  it('marks successful authenticated reads private and no-store', async () => {
    const token = await clinicianA();
    for (const path of ['/api/v1/patients', '/api/v1/reports', '/api/v1/me']) {
      const res = await api().get(path).set(bearer(token)).expect(200);
      expect([path, res.headers['cache-control']]).toEqual([path, NO_STORE]);
    }
  });

  it('marks a created record and a validation error private and no-store', async () => {
    const token = await clinicianA();
    const created = await api().post('/api/v1/patients').set(bearer(token)).send({ label: 'SYN-NOSTORE' }).expect(201);
    expect(created.headers['cache-control']).toBe(NO_STORE);
    const invalid = await api().post('/api/v1/patients').set(bearer(token)).send({ label: '' }).expect(400);
    expect(invalid.headers['cache-control']).toBe(NO_STORE);
    const malformed = await api().post('/api/v1/patients').set(bearer(token)).set('Content-Type', 'application/json').send('{"label":').expect(400);
    expect(malformed.headers['cache-control']).toBe(NO_STORE);
  });

  it('marks 401, 403 and 404 responses no-store', async () => {
    expect((await api().get('/api/v1/patients').expect(401)).headers['cache-control']).toBe(NO_STORE);
    expect((await api().get('/api/v1/patients').set(bearer('not-a-token')).expect(401)).headers['cache-control']).toBe(NO_STORE);
    const forbidden = await api()
      .post('/api/v1/patients')
      .set(bearer(await readerA()))
      .send({ label: 'SYN-FORBIDDEN' })
      .expect(403);
    expect(forbidden.headers['cache-control']).toBe(NO_STORE);
    const missing = await api()
      .get(`/api/v1/patients/${MISSING_ID}`)
      .set(bearer(await clinicianA()))
      .expect(404);
    expect(missing.headers['cache-control']).toBe(NO_STORE);
    expect(
      (
        await api()
          .get('/api/v1/no-such-route')
          .set(bearer(await clinicianA()))
          .expect(404)
      ).headers['cache-control'],
    ).toBe(NO_STORE);
  });

  it('marks the public health and readiness answers no-store too, so a probe never reads a stale answer', async () => {
    expect((await api().get('/api/v1/health').expect(200)).headers['cache-control']).toBe(NO_STORE);
    expect((await api().get('/api/v1/ready').expect(200)).headers['cache-control']).toBe(NO_STORE);
  });

  it('keeps the header on a 429 rate-limit answer', async () => {
    const limited = await createTestApp({ rateLimit: { ip: 1000, read: 1 } });
    try {
      const token = await clinicianA();
      await request(limited.getHttpServer()).get('/api/v1/patients').set(bearer(token)).expect(200);
      const res = await request(limited.getHttpServer()).get('/api/v1/patients').set(bearer(token)).expect(429);
      expect(res.headers['cache-control']).toBe(NO_STORE);
      expect(res.headers['retry-after']).toBeDefined();
    } finally {
      await limited.close();
    }
  });
});
