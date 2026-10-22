import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp } from './helpers/app';

/** Every API response, including errors, carries the browser-side protections (audit FE-05). */
const EXPECTED = {
  'x-content-type-options': 'nosniff',
  'strict-transport-security': 'max-age=31536000',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
};

let app: NestExpressApplication;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
});

describe('security headers on every API response', () => {
  it('sets all five on a successful response', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    for (const [name, value] of Object.entries(EXPECTED)) expect(res.headers[name]).toBe(value);
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('sets them on an error response too, so a 404 cannot be framed or sniffed', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/does-not-exist').expect(404);
    for (const [name, value] of Object.entries(EXPECTED)) expect(res.headers[name]).toBe(value);
  });
});
