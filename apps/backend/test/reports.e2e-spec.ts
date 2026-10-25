import type { NestExpressApplication } from '@nestjs/platform-express';
import { MAX_REPORT_BYTES, reportDtoSchema } from '@telesphoros/shared-types';
import request from 'supertest';
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
const BASE = '/api/v1/reports';
const newPatient = async (token: string, label: string) => (await api().post('/api/v1/patients').set(bearer(token)).send({ label }).expect(201)).body.id as string;
const validBody = (patientId: string) => ({ patientId, type: 'vcf', filename: 'sample.vcf', sizeBytes: 1024 });

describe('reports', () => {
  it('registers report metadata for the caller’s own patient, always with status "received"', async () => {
    const a = await clinicianA();
    const patientId = await newPatient(a, 'SYN-R-1');
    const res = await api().post(BASE).set(bearer(a)).send(validBody(patientId)).expect(201);
    expect(res.body.status).toBe('received');
    expect(reportDtoSchema.safeParse(res.body).success).toBe(true);
    expect(JSON.stringify(res.body)).not.toMatch(/owner|tenant|created_?by|user-a/i);
  });

  it('forbids a reader from creating reports', async () => {
    const a = await clinicianA();
    const patientId = await newPatient(a, 'SYN-R-2');
    await api()
      .post(BASE)
      .set(bearer(await readerA()))
      .send(validBody(patientId))
      .expect(403);
  });

  it('treats another user’s patient exactly like a missing one (404)', async () => {
    const patientOfA = await newPatient(await clinicianA(), 'SYN-R-3');
    const res = await api()
      .post(BASE)
      .set(bearer(await clinicianB()))
      .send(validBody(patientOfA))
      .expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    await api()
      .post(BASE)
      .set(bearer(await clinicianA()))
      .send(validBody('3f2b8c1e-5a47-4d0e-9c3a-1b2c3d4e5f60'))
      .expect(404);
  });

  it.each([
    ['client-supplied status', (id: string) => ({ ...validBody(id), status: 'processed' })],
    ['path traversal filename', (id: string) => ({ ...validBody(id), filename: '../../etc/passwd.vcf' })],
    ['disallowed extension', (id: string) => ({ ...validBody(id), filename: 'malware.exe' })],
    ['oversize file', (id: string) => ({ ...validBody(id), sizeBytes: MAX_REPORT_BYTES + 1 })],
    ['zero size', (id: string) => ({ ...validBody(id), sizeBytes: 0 })],
    ['unknown type', (id: string) => ({ ...validBody(id), type: 'pdf' })],
    ['bad patient id', () => ({ ...validBody('nope') })],
  ])('rejects %s with 400 VALIDATION_ERROR', async (_name, make) => {
    const a = await clinicianA();
    const patientId = await newPatient(a, `SYN-V-${Math.random().toString(36).slice(2, 8)}`);
    const res = await api().post(BASE).set(bearer(a)).send(make(patientId)).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('PATCH corrects metadata, but needs at least one valid field and refuses unknown ones', async () => {
    const a = await clinicianA();
    const created = (
      await api()
        .post(BASE)
        .set(bearer(a))
        .send(validBody(await newPatient(a, 'SYN-P-1')))
        .expect(201)
    ).body;
    const ok = await api().patch(`${BASE}/${created.id}`).set(bearer(a)).send({ type: 'structured', filename: 'fixed.json' }).expect(200);
    expect(ok.body).toMatchObject({ type: 'structured', filename: 'fixed.json', status: 'received' });
    await api().patch(`${BASE}/${created.id}`).set(bearer(a)).send({}).expect(400);
    await api().patch(`${BASE}/${created.id}`).set(bearer(a)).send({ status: 'processed' }).expect(400);
  });

  it('scopes list, get, patch and delete to the owner, and filters by patient', async () => {
    const a = await clinicianA();
    const b = await clinicianB();
    const p1 = await newPatient(a, 'SYN-S-1');
    const p2 = await newPatient(a, 'SYN-S-2');
    const r1 = (await api().post(BASE).set(bearer(a)).send(validBody(p1)).expect(201)).body;
    await api().post(BASE).set(bearer(a)).send(validBody(p2)).expect(201);

    const filtered = await api().get(`${BASE}?patientId=${p1}`).set(bearer(a)).expect(200);
    expect(filtered.body.data.every((r: { patientId: string }) => r.patientId === p1)).toBe(true);
    expect(filtered.body.meta.total).toBe(1);

    expect((await api().get(BASE).set(bearer(b)).expect(200)).body.data).toEqual([]);
    for (const res of [
      await api().get(`${BASE}/${r1.id}`).set(bearer(b)),
      await api().patch(`${BASE}/${r1.id}`).set(bearer(b)).send({ type: 'structured' }),
      await api().delete(`${BASE}/${r1.id}`).set(bearer(b)),
    ]) {
      expect(res.status).toBe(404);
    }
    await api().delete(`${BASE}/${r1.id}`).set(bearer(a)).expect(204);
  });
});
