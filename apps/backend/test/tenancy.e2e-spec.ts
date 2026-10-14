import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { errorResponseSchema } from '@telesphoros/shared-types';
import request from 'supertest';
import { PatientsRepository } from '../src/storage/patients.repository';
import { ReportsRepository } from '../src/storage/reports.repository';
import { createTestApp } from './helpers/app';
import { bearer, signToken } from './helpers/tokens';

let app: NestExpressApplication;
beforeAll(async () => {
  app = await createTestApp({organizationIntake: true});
});
afterAll(async () => {
  await app.close();
});

const api = () => request(app.getHttpServer());
const label = () => `SYN-${randomUUID().slice(0, 8)}`;
/** Two people in one organization, and one person in another. */
const acme = `acme-${randomUUID().slice(0, 8)}`;
const globex = `globex-${randomUUID().slice(0, 8)}`;
const ann = () => signToken({ sub: 'ann', tenant: acme, roles: ['clinician'] });
const ben = () => signToken({ sub: 'ben', tenant: acme, roles: ['clinician'] });
const readerInAcme = () => signToken({ sub: 'rae', tenant: acme, roles: ['reader'] });
const gus = () => signToken({ sub: 'gus', tenant: globex, roles: ['clinician'] });

describe('tenancy: members of one organization share its records', () => {
  it('a colleague sees, reads and changes a record someone else in the tenant created', async () => {
    const mine = (await api().post('/api/v1/patients').set(bearer(await ann())).send({ label: label() }).expect(201)).body;

    const list = await api().get('/api/v1/patients').set(bearer(await ben())).expect(200);
    expect(list.body.data.map((p: { id: string }) => p.id)).toContain(mine.id);
    await api().get(`/api/v1/patients/${mine.id}`).set(bearer(await ben())).expect(200);
    await api().get(`/api/v1/patients/${mine.id}`).set(bearer(await readerInAcme())).expect(200);

    const renamed = label();
    await api().put(`/api/v1/patients/${mine.id}`).set(bearer(await ben())).send({ label: renamed }).expect(200);
    const report = (
      await api().post('/api/v1/reports').set(bearer(await ben())).send({ patientId: mine.id, type: 'vcf', filename: 'a.vcf', sizeBytes: 10 }).expect(201)
    ).body;
    await api().get(`/api/v1/reports/${report.id}`).set(bearer(await ann())).expect(200);
    await api().delete(`/api/v1/reports/${report.id}`).set(bearer(await ann())).expect(204);
  });

  it('a label is unique within a tenant, across its members, but free in another tenant', async () => {
    const shared = label();
    await api().post('/api/v1/patients').set(bearer(await ann())).send({ label: shared }).expect(201);
    const clash = await api().post('/api/v1/patients').set(bearer(await ben())).send({ label: shared.toLowerCase() }).expect(409);
    expect(clash.body.error.code).toBe('CONFLICT');
    await api().post('/api/v1/patients').set(bearer(await gus())).send({ label: shared }).expect(201);
  });
});

describe('tenancy: another organization sees nothing, and cannot tell what exists', () => {
  it('lists, reads, changes and deletes of another tenant’s records are all NOT_FOUND', async () => {
    const patient = (await api().post('/api/v1/patients').set(bearer(await ann())).send({ label: label() }).expect(201)).body;
    const report = (
      await api().post('/api/v1/reports').set(bearer(await ann())).send({ patientId: patient.id, type: 'vcf', filename: 'a.vcf', sizeBytes: 10 }).expect(201)
    ).body;

    const theirList = await api().get('/api/v1/patients').set(bearer(await gus())).expect(200);
    expect(theirList.body.data.map((p: { id: string }) => p.id)).not.toContain(patient.id);
    for (const path of [`/api/v1/patients/${patient.id}`, `/api/v1/reports/${report.id}`]) {
      expect((await api().get(path).set(bearer(await gus())).expect(404)).body.error.code).toBe('NOT_FOUND');
    }
    await api().put(`/api/v1/patients/${patient.id}`).set(bearer(await gus())).send({ label: label() }).expect(404);
    await api().delete(`/api/v1/reports/${report.id}`).set(bearer(await gus())).expect(404);
    // A report for someone else's patient is the same NOT_FOUND as for a missing one.
    await api().post('/api/v1/reports').set(bearer(await gus())).send({ patientId: patient.id, type: 'vcf', filename: 'a.vcf', sizeBytes: 10 }).expect(404);
  });
});

describe('tenancy: the individual is recorded by the server, not the client', () => {
  it('created_by is the caller’s subject (not the tenant), whatever the client sends', async () => {
    const created = (await api().post('/api/v1/patients').set(bearer(await ann())).send({ label: label() }).expect(201)).body;
    const stored = await app.get(PatientsRepository).findById(acme, created.id);
    expect(stored).toMatchObject({ tenantId: acme, createdBy: 'ann' });

    for (const extra of [{ createdBy: 'ben' }, { created_by: 'ben' }, { tenantId: globex }, { tenant_id: globex }, { ownerId: 'ben' }]) {
      const res = await api().post('/api/v1/patients').set(bearer(await ann())).send({ label: label(), ...extra }).expect(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }

    const patient = (await api().post('/api/v1/patients').set(bearer(await ben())).send({ label: label() }).expect(201)).body;
    const report = (
      await api().post('/api/v1/reports').set(bearer(await ben())).send({ patientId: patient.id, type: 'vcf', filename: 'a.vcf', sizeBytes: 10 }).expect(201)
    ).body;
    expect(await app.get(ReportsRepository).findById(acme, report.id)).toMatchObject({ tenantId: acme, createdBy: 'ben' });
  });

  it('a colleague’s edit does not change who created the record', async () => {
    const created = (await api().post('/api/v1/patients').set(bearer(await ann())).send({ label: label() }).expect(201)).body;
    await api().put(`/api/v1/patients/${created.id}`).set(bearer(await ben())).send({ label: label() }).expect(200);
    expect(await app.get(PatientsRepository).findById(acme, created.id)).toMatchObject({ createdBy: 'ann' });
  });
});

describe('tenancy: stored files are grouped by tenant, not by person', () => {
  it('colleagues’ uploads share one storage prefix, another tenant’s differs, and no raw id appears in it', async () => {
    const keyFor = async (token: string, tenantId: string) => {
      const patient = (await api().post('/api/v1/patients').set(bearer(token)).send({ label: label() }).expect(201)).body;
      const report = (await api().post('/api/v1/reports').set(bearer(token)).send({ patientId: patient.id, type: 'vcf', filename: 'a.vcf', sizeBytes: 10 }).expect(201)).body;
      const revision = (await api().get(`/api/v1/reports/${report.id}/upload-state`).set(bearer(token)).expect(200)).body.revision;
      await api().post(`/api/v1/reports/${report.id}/upload-attempts`).set(bearer(token)).send({ requestId: randomUUID(), revision, contentType: 'text/plain', sha256: 'a'.repeat(64) }).expect(201);
      return (await app.get(ReportsRepository).findById(tenantId, report.id))!.storageKey!;
    };
    const [annKey, benKey, gusKey] = [await keyFor(await ann(), acme), await keyFor(await ben(), acme), await keyFor(await gus(), globex)];
    const prefix = (key: string) => key.split('/').slice(0, 2).join('/');
    expect(prefix(annKey)).toBe(prefix(benKey));
    expect(prefix(gusKey)).not.toBe(prefix(annKey));
    for (const key of [annKey, benKey, gusKey]) expect(key).not.toMatch(/ann|ben|gus|acme|globex/);
  });
});

describe('tenancy: a genuine token without exactly one tenant is refused with 403', () => {
  const routes = ['/api/v1/me', '/api/v1/patients', '/api/v1/reports', '/api/v1/recommendations'];

  it.each([
    ['no tenant claim', null],
    ['an empty tenant', ''],
    ['an upper-case tenant', 'Acme'],
    ['a tenant with a space', 'a b'],
  ])('%s', async (_name, tenant) => {
    const token = await signToken({ sub: 'zed', tenant, roles: ['clinician'] });
    for (const route of routes) {
      const res = await api().get(route).set(bearer(token)).expect(403);
      expect(errorResponseSchema.safeParse(res.body).success).toBe(true);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
    await api().post('/api/v1/patients').set(bearer(token)).send({ label: label() }).expect(403);
  });

  it('an invalid token is still 401, so a forged token learns nothing about tenants', async () => {
    const forged = await signToken({ tenant: null, secret: 'another-secret-another-secret-another-1234' });
    expect((await api().get('/api/v1/me').set(bearer(forged)).expect(401)).body.error.code).toBe('UNAUTHORIZED');
  });
});
