import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { recommendationDtoSchema } from '@telesphoros/shared-types';
import request from 'supertest';
import { RecommendationsRepository } from '../src/storage/recommendations.repository';
import type { RecommendationRecord } from '../src/storage/records';
import { createTestApp } from './helpers/app';
import { bearer, clinicianA, clinicianB, readerA } from './helpers/tokens';

let app: NestExpressApplication;
const patientId = randomUUID();
const reportId = randomUUID();
const otherReportId = randomUUID();
const mine = (overrides: Partial<RecommendationRecord> = {}): RecommendationRecord => ({
  id: randomUUID(),
  ownerId: 'user-a',
  patientId,
  reportId,
  gene: 'GENE1',
  drug: 'drug-x',
  phenotype: 'Test phenotype',
  summary: 'Synthetic test recommendation.',
  strength: 'Strong',
  guidelineVersion: 'test-0',
  createdAt: new Date().toISOString(),
  ...overrides,
});

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
});

const api = () => request(app.getHttpServer());
const BASE = '/api/v1/recommendations';

describe('recommendations are read-only', () => {
  it.each([
    ['POST', () => api().post(BASE)],
    ['PUT', () => api().put(`${BASE}/${randomUUID()}`)],
    ['PATCH', () => api().patch(`${BASE}/${randomUUID()}`)],
    ['DELETE', () => api().delete(`${BASE}/${randomUUID()}`)],
  ])('has no %s route: a client can never author a clinical recommendation', async (_method, call) => {
    const res = await call().set(bearer(await clinicianA())).send({ gene: 'X' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('recommendations: reading', () => {
  it('lists and fetches the caller’s own records with exactly the public fields, scoped and filterable', async () => {
    const repo = app.get(RecommendationsRepository);
    const first = mine();
    await repo.insert(first);
    await repo.insert(mine({ reportId: otherReportId, createdAt: new Date(Date.now() + 1000).toISOString() }));
    await repo.insert(mine({ ownerId: 'user-b' }));

    const a = await clinicianA();
    const list = await api().get(BASE).set(bearer(a)).expect(200);
    expect(list.body.meta.total).toBe(2);
    for (const rec of list.body.data) {
      expect(recommendationDtoSchema.safeParse(rec).success).toBe(true);
      expect(JSON.stringify(rec)).not.toMatch(/owner|user-[ab]/i);
    }

    const filtered = await api().get(`${BASE}?reportId=${otherReportId}`).set(bearer(a)).expect(200);
    expect(filtered.body.meta.total).toBe(1);

    await api().get(`${BASE}/${first.id}`).set(bearer(await readerA())).expect(200);
    expect((await api().get(BASE).set(bearer(await clinicianB())).expect(200)).body.data).toHaveLength(1);
    await api().get(`${BASE}/${first.id}`).set(bearer(await clinicianB())).expect(404);
  });
});
