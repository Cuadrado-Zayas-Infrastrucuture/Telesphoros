import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp } from './helpers/app';
import { bearer, clinicianA, readerA, signToken } from './helpers/tokens';

let app: NestExpressApplication;
let token: string;
beforeAll(async () => {
  app = await createTestApp();
  token = await clinicianA();
});
afterAll(async () => {
  await app.close();
});
const api = () => request(app.getHttpServer());
const base = '/api/v1/reports';
const patient = async (who = token) =>
  (
    await api()
      .post('/api/v1/patients')
      .set(bearer(who))
      .send({ label: `SYN-${randomUUID()}` })
      .expect(201)
  ).body.id as string;
const metadata = (patientId: string) => ({ patientId, type: 'structured', filename: 'synthetic.json', sizeBytes: 100 });
const create = (body: object, who = token) => api().post(base).set(bearer(who)).send(body);

describe('report registration retries', () => {
  it('preserves unkeyed creation: discarding a response then repeating metadata creates two records', async () => {
    const body = metadata(await patient());
    await create(body).expect(201); // simulate the caller losing the first response
    await create(body).expect(201);
    const listed = await api().get(`${base}?patientId=${body.patientId}`).set(bearer(token)).expect(200);
    expect(listed.body.meta.total).toBe(2);
    expect(new Set(listed.body.data.map((row: { id: string }) => row.id)).size).toBe(2);
  });

  it('recovers a lost keyed response and collapses concurrent retries to one report', async () => {
    const body = { ...metadata(await patient()), requestId: randomUUID() };
    await create(body).expect(201); // caller does not retain the response
    const responses = await Promise.all(Array.from({ length: 8 }, () => create(body).expect(201)));
    expect(new Set(responses.map((response) => response.body.id)).size).toBe(1);
    const listed = await api().get(`${base}?patientId=${body.patientId}`).set(bearer(token)).expect(200);
    expect(listed.body.meta.total).toBe(1);
    expect(responses[0]!.body.id).toBe(listed.body.data[0].id);
    expect(JSON.stringify(responses[0]!.body)).not.toMatch(/requestId|requestHash|creation_request|tenant|createdBy/);
  });

  it('canonicalizes UUID request keys and keeps distinct keys independent', async () => {
    const body = { ...metadata(await patient()), requestId: randomUUID() };
    const first = await create(body).expect(201);
    const replay = await create({ ...body, requestId: body.requestId.toUpperCase() }).expect(201);
    expect(replay.body.id).toBe(first.body.id);
    const other = await create({ ...body, requestId: randomUUID() }).expect(201);
    expect(other.body.id).not.toBe(first.body.id);
  });

  it.each(['patientId', 'type', 'filename', 'sizeBytes'])('refuses key reuse with changed %s', async (field) => {
    const body = { ...metadata(await patient()), requestId: randomUUID() };
    const otherPatient = await patient();
    const first = await create(body).expect(201);
    const changed =
      field === 'type'
        ? { type: 'lab-pdf', filename: 'synthetic.pdf' }
        : field === 'patientId'
          ? { patientId: otherPatient }
          : field === 'filename'
            ? { filename: 'different.json' }
            : { sizeBytes: 101 };
    const refusal = await create({ ...body, ...changed }).expect(409);
    expect(refusal.body.error.code).toBe('CONFLICT');
    expect((await create(body).expect(201)).body.id).toBe(first.body.id);
    expect((await api().get(`${base}?patientId=${body.patientId}`).set(bearer(token)).expect(200)).body.meta.total).toBe(1);
  });

  it('matches the original snapshot after a metadata correction and returns current state', async () => {
    const body = { ...metadata(await patient()), requestId: randomUUID() };
    const first = await create(body).expect(201);
    await api().patch(`${base}/${first.body.id}`).set(bearer(token)).send({ filename: 'corrected.json' }).expect(200);
    const replay = await create(body).expect(201);
    expect(replay.body).toMatchObject({ id: first.body.id, filename: 'corrected.json' });
    await create({ ...body, filename: 'corrected.json' }).expect(409);
  });

  it('reserves keys across soft deletion instead of resurrecting or duplicating a report', async () => {
    const body = { ...metadata(await patient()), requestId: randomUUID() };
    const first = await create(body).expect(201);
    await api().delete(`${base}/${first.body.id}`).set(bearer(token)).expect(204);
    await create(body).expect(409);
    await api().get(`${base}/${first.body.id}`).set(bearer(token)).expect(404);
    expect((await api().get(`${base}?patientId=${body.patientId}`).set(bearer(token)).expect(200)).body.meta.total).toBe(0);
    expect((await create({ ...body, requestId: randomUUID() }).expect(201)).body.id).not.toBe(first.body.id);
  });

  it('scopes keys to both tenant and creator, preserving shared-tenant permissions', async () => {
    const body = { ...metadata(await patient()), requestId: randomUUID() };
    const first = await create(body).expect(201);
    const colleague = await signToken({ sub: 'syn-colleague', tenant: 'tenant-user-a', roles: ['clinician'] });
    const sameTenant = await create(body, colleague).expect(201);
    expect(sameTenant.body.id).not.toBe(first.body.id);
    expect((await create(body, colleague).expect(201)).body.id).toBe(sameTenant.body.id);
    const foreign = await signToken({ sub: 'user-a', tenant: 'syn-foreign', roles: ['clinician'] });
    await create(body, foreign).expect(404);
    const foreignBody = { ...body, patientId: await patient(foreign) };
    const foreignReport = await create(foreignBody, foreign).expect(201);
    expect(foreignReport.body.id).not.toBe(first.body.id);
    expect((await create(foreignBody, foreign).expect(201)).body.id).toBe(foreignReport.body.id);
    await create(body, await readerA()).expect(403);
    await api().post(base).send(body).expect(401);
    expect((await create(body).expect(201)).body.id).toBe(first.body.id);
  });

  it.each([null, '', 'not-a-uuid', 42])('rejects invalid request keys (%j) without creating metadata', async (requestId) => {
    const body = metadata(await patient());
    await create({ ...body, requestId }).expect(400);
    expect((await api().get(`${base}?patientId=${body.patientId}`).set(bearer(token)).expect(200)).body.meta.total).toBe(0);
    await create({ ...body, requestId: randomUUID() }).expect(201);
  });
});
