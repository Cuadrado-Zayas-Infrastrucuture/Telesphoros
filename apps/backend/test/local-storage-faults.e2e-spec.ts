import { createHash, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { ObjectStorage } from '../src/object-storage/object-storage';
import { ReportsRepository } from '../src/storage/reports.repository';
import { createTestApp } from './helpers/app';
import { bearer, clinicianA } from './helpers/tokens';
const bytes = Buffer.from('%PDF-1.7\nSynthetic fault fixture\n%%EOF\n');
const hash = createHash('sha256').update(bytes).digest('hex');
let app: NestExpressApplication, token: string;
const api = () => request(app.getHttpServer());
beforeEach(async () => {
  app = await createTestApp();
  token = await clinicianA();
});
afterEach(async () => {
  await app.close();
});
async function attempt() {
  const p = (await api().post('/api/v1/patients').set(bearer(token)).send({ label: 'SYN-FAULT' }).expect(201)).body.id;
  const id = (await api().post('/api/v1/reports').set(bearer(token)).send({ patientId: p, type: 'lab-pdf', filename: 'inert.pdf', sizeBytes: bytes.length }).expect(201)).body.id;
  const revision = (await api().get(`/api/v1/reports/${id}/upload-state`).set(bearer(token))).body.revision;
  const a = (
    await api()
      .post(`/api/v1/reports/${id}/upload-attempts`)
      .set(bearer(token))
      .send({ requestId: randomUUID(), revision, contentType: 'application/pdf', sha256: hash })
      .expect(201)
  ).body;
  return { id, ...a };
}
const put = (a: { id: string; attemptId: string; revision: string }) =>
  api()
    .put(`/api/v1/reports/${a.id}/upload-attempts/${a.attemptId}/bytes`)
    .set(bearer(token))
    .set('X-Upload-Revision', a.revision)
    .set('Content-Type', 'application/pdf')
    .send(bytes);
const resume = (a: { id: string; attemptId: string; revision: string }) =>
  api().post(`/api/v1/reports/${a.id}/upload-attempts/${a.attemptId}/resume`).set(bearer(token)).set('X-Upload-Revision', a.revision);
it('reconciles a lost S3 reply using the existing exact version without another write', async () => {
  const a = await attempt();
  const storage = app.get(ObjectStorage);
  const original = storage.putStream.bind(storage);
  const spy = jest.spyOn(storage, 'putStream').mockImplementationOnce(async (...args) => {
    await original(...args);
    throw new Error('Synthetic reply loss');
  });
  await put(a).expect(500);
  expect((await resume(a).expect(200)).body.state).toBe('committed');
  expect(spy).toHaveBeenCalledTimes(1);
  spy.mockRestore();
});
it('preserves a pin when the database commit reply is lost', async () => {
  const a = await attempt();
  const repo = app.get(ReportsRepository);
  const commit = repo.commitAttempt.bind(repo);
  const spy = jest.spyOn(repo, 'commitAttempt').mockImplementationOnce(async (i) => {
    await commit(i);
    throw new Error('Synthetic DB reply loss');
  });
  await put(a).expect(500);
  spy.mockRestore();
  expect((await resume(a).expect(200)).body.state).toBe('committed');
});
it('retains the stored attempt after a rollback and safely resumes', async () => {
  const a = await attempt();
  const repo = app.get(ReportsRepository);
  const spy = jest.spyOn(repo, 'commitAttempt').mockRejectedValueOnce(new Error('Synthetic rollback'));
  await put(a).expect(500);
  spy.mockRestore();
  expect((await resume(a).expect(200)).body.state).toBe('committed');
});
it('refuses a declaration that changes while the exact bytes are being inspected', async () => {
  const a = await attempt();
  const storage = app.get(ObjectStorage);
  const inspect = storage.inspect.bind(storage);
  const spy = jest.spyOn(storage, 'inspect').mockImplementationOnce(async (...args) => {
    await api().patch(`/api/v1/reports/${a.id}`).set(bearer(token)).send({ type: 'structured', filename: 'inert.json' }).expect(200);
    return inspect(...args);
  });
  await put(a).expect(409);
  spy.mockRestore();
  expect((await api().get(`/api/v1/reports/${a.id}`).set(bearer(token))).body.fileUploaded).toBe(false);
});
it('cancellation during read-back prevents completion and preserves bytes for owned cleanup', async () => {
  const a = await attempt();
  const storage = app.get(ObjectStorage);
  const inspect = storage.inspect.bind(storage);
  const spy = jest.spyOn(storage, 'inspect').mockImplementationOnce(async (...args) => {
    await api().post(`/api/v1/reports/${a.id}/upload-attempts/${a.attemptId}/cancel`).set(bearer(token)).set('X-Upload-Revision', a.revision).expect(200);
    return inspect(...args);
  });
  await put(a).expect(409);
  spy.mockRestore();
  const state = await app.get(ReportsRepository).findAttempt({ tenantId: 'tenant-user-a', principal: 'user-a', reportId: a.id, id: a.attemptId, revision: a.revision });
  expect(state?.state).toBe('cancelled');
  expect(state?.version).toBeTruthy();
});
it('two concurrent intakes of one attempt have exactly one winning writer', async () => {
  const a = await attempt();
  const results = await Promise.all([put(a), put(a)]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  const repo = app.get(ReportsRepository);
  const record = (await repo.findById('tenant-user-a', a.id))!;
  expect(record.uploadedBy).toBe('user-a');
  expect(record.sha256).toBe(hash);
});
it('soft deletion during inspection prevents a pin', async () => {
  const a = await attempt();
  const storage = app.get(ObjectStorage);
  const inspect = storage.inspect.bind(storage);
  const spy = jest.spyOn(storage, 'inspect').mockImplementationOnce(async (...args) => {
    await api().delete(`/api/v1/reports/${a.id}`).set(bearer(token)).expect(204);
    return inspect(...args);
  });
  await put(a).expect(409);
  spy.mockRestore();
});
it('unavailable inventory refuses declaration and causes no writes', async () => {
  const a = await attempt();
  const storage = app.get(ObjectStorage);
  const spy = jest.spyOn(storage, 'uploadVersions').mockRejectedValueOnce(new Error('Synthetic listing outage'));
  const revision = (await api().get(`/api/v1/reports/${a.id}/upload-state`).set(bearer(token))).body.revision;
  await api()
    .post(`/api/v1/reports/${a.id}/upload-attempts`)
    .set(bearer(token))
    .send({ requestId: randomUUID(), revision, contentType: 'application/pdf', sha256: hash })
    .expect(503);
  spy.mockRestore();
}); // 503 since M2.2a (a listing outage is "try later"); it was an unhandled 500

it('cancellation with a lost S3 write reply reconciles to cancelled without pinning or a second PUT', async () => {
  const a = await attempt();
  const storage = app.get(ObjectStorage);
  const original = storage.putStream.bind(storage);
  const spy = jest.spyOn(storage, 'putStream').mockImplementationOnce(async (...args) => {
    await original(...args);
    await api().post(`/api/v1/reports/${a.id}/upload-attempts/${a.attemptId}/cancel`).set(bearer(token)).set('X-Upload-Revision', a.revision).expect(200);
    throw new Error('Synthetic cancelled write reply loss');
  });
  await put(a).expect(409);
  const repo = app.get(ReportsRepository);
  const identity = { tenantId: 'tenant-user-a', principal: 'user-a', reportId: a.id, id: a.attemptId, revision: a.revision };
  expect(await repo.findAttempt(identity)).toMatchObject({ state: 'unresolved', cancelRequested: true, version: null });
  await resume(a).expect(409);
  expect(await repo.findAttempt(identity)).toMatchObject({ state: 'cancelled', cancelRequested: true });
  const report = (await repo.findById(identity.tenantId, a.id))!;
  expect(report.uploadedAt ?? null).toBeNull();
  expect(report.objectVersion ?? null).toBeNull();
  expect((await api().get(`/api/v1/reports/${a.id}`).set(bearer(token)).expect(200)).body.fileUploaded).toBe(false);
  expect(spy).toHaveBeenCalledTimes(1);
  spy.mockRestore();
});
