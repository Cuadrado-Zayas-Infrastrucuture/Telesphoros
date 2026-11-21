import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp } from './helpers/app';
import { bearer, readerA, signToken } from './helpers/tokens';

// Spec 046 T-5 in every tier: the review is for admins only, and it reads PostgreSQL alone, so with the in-memory store it answers 503 as the other
// PostgreSQL-only routes do. The PostgreSQL behaviour is in test/db/access-review.pg-spec.ts and access-review-api.pg-spec.ts.
const usingPostgres = process.env.TEST_STORAGE === 'postgres';
let app: NestExpressApplication;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app?.close();
});
const api = () => request(app.getHttpServer());
const admin = () => signToken({ sub: 'syn-ar-e2e-admin', roles: ['admin'] });
const clinician = () => signToken({ sub: 'syn-ar-e2e-clinician', roles: ['clinician'] });

it('answers 403 to every role but admin, on the review and on the export', async () => {
  for (const token of [await clinician(), await readerA(), await signToken({ sub: 'syn-ar-e2e-reviewer', roles: ['reviewer'] })]) {
    await api().get('/api/v1/access-review').set(bearer(token)).expect(403);
    await api().get('/api/v1/access-review/export').set(bearer(token)).expect(403);
  }
});

it(`answers an admin with ${usingPostgres ? 'the review' : '503 (the review reads PostgreSQL only)'}`, async () => {
  const res = await api().get('/api/v1/access-review').set(bearer(await admin()));
  expect(res.status).toBe(usingPostgres ? 200 : 503);
  const csv = await api().get('/api/v1/access-review/export').set(bearer(await admin()));
  expect(csv.status).toBe(usingPostgres ? 200 : 503);
});

it('refuses a filter naming both a patient and a member, and a window over 92 days, before reading anything', async () => {
  const token = await admin();
  await api().get('/api/v1/access-review').query({ patientId: '7c9e6679-7425-40de-944b-e07fc1f90ae7', member: 'someone' }).set(bearer(token)).expect(400);
  await api().get('/api/v1/access-review').query({ from: '2026-01-01T00:00:00Z', to: '2026-06-01T00:00:00Z' }).set(bearer(token)).expect(400);
  await api().get('/api/v1/access-review').query({ unknown: '1' }).set(bearer(token)).expect(400);
});
