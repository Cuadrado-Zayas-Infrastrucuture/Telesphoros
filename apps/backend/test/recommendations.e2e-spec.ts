import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { recommendationDtoSchema } from '@telesphoros/shared-types';
import request from 'supertest';
import { RecommendationsRepository } from '../src/storage/recommendations.repository';
import type { RecommendationRecord } from '../src/storage/records';
import { createTestApp } from './helpers/app';
import { bearer, clinicianA, clinicianB, readerA } from './helpers/tokens';

let app: NestExpressApplication;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
});

const api = () => request(app.getHttpServer());
const BASE = '/api/v1/recommendations';

/** Real parent rows, created through the API: the database enforces the foreign keys. */
async function seedParents(token: string) {
  const patient = (await api().post('/api/v1/patients').set(bearer(token)).send({ label: `SYN-${randomUUID().slice(0, 8)}` }).expect(201)).body.id as string;
  const mkReport = async () =>
    (await api().post('/api/v1/reports').set(bearer(token)).send({ patientId: patient, type: 'vcf', filename: 'a.vcf', sizeBytes: 10 }).expect(201)).body.id as string;
  return { patientId: patient, reportId: await mkReport(), otherReportId: await mkReport() };
}
const record = (ownerId: string, patientId: string, reportId: string, over: Partial<RecommendationRecord> = {}): RecommendationRecord => ({
  id: randomUUID(), ownerId, patientId, reportId, gene: 'GENE1', drug: 'drug-x', phenotype: 'Test phenotype',
  summary: 'Synthetic test recommendation.', strength: 'Strong', guidelineVersion: 'test-0', createdAt: new Date().toISOString(), ...over,
});

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
    const a = await clinicianA();
    const b = await clinicianB();
    const mineParents = await seedParents(a);
    const theirParents = await seedParents(b);

    const first = record('user-a', mineParents.patientId, mineParents.reportId);
    await repo.insert(first);
    await repo.insert(record('user-a', mineParents.patientId, mineParents.otherReportId, { createdAt: new Date(Date.now() + 1000).toISOString() }));
    await repo.insert(record('user-b', theirParents.patientId, theirParents.reportId));

    const list = await api().get(BASE).set(bearer(a)).expect(200);
    expect(list.body.meta.total).toBe(2);
    for (const rec of list.body.data) {
      expect(recommendationDtoSchema.safeParse(rec).success).toBe(true);
      expect(JSON.stringify(rec)).not.toMatch(/owner|user-[ab]/i);
    }

    const filtered = await api().get(`${BASE}?reportId=${mineParents.otherReportId}`).set(bearer(a)).expect(200);
    expect(filtered.body.meta.total).toBe(1);

    await api().get(`${BASE}/${first.id}`).set(bearer(await readerA())).expect(200);
    expect((await api().get(BASE).set(bearer(b)).expect(200)).body.data).toHaveLength(1);
    await api().get(`${BASE}/${first.id}`).set(bearer(b)).expect(404);
  });
});
