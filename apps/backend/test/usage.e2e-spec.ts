import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { type Role, usageDtoSchema } from '@telesphoros/shared-types';
import { NO_STORE } from '../src/common/no-store.middleware';
import { ReportsRepository } from '../src/storage/reports.repository';
import { usageWindows } from '../src/usage/usage-months';
import { createTestApp, tenantsOf } from './helpers/app';
import { bearer, signToken } from './helpers/tokens';
import { commitUpload } from './helpers/uploads';

/**
 * GET /usage (specs/010-usage): an organization's own counts, for its administrators. Runs on every storage tier; on PostgreSQL the counts are
 * read through the application role. Exact counting at month edges is in test/db/usage.pg-spec.ts.
 */
const suffix = randomUUID().slice(0, 8);
const ALPHA = `tenant-usage-alpha-${suffix}`;
const BETA = `tenant-usage-beta-${suffix}`;
let app: NestExpressApplication;
const api = () => request(app.getHttpServer());
const token = (tenant: string, roles: Role[]) => signToken({ sub: `person-${randomUUID().slice(0, 8)}`, tenant, roles });
const usage = async (tenant: string, roles: Role[] = ['admin']) =>
  api()
    .get('/api/v1/usage')
    .set(bearer(await token(tenant, roles)));

/** A report registered through the API and uploaded the way the intake commits it, with the given recorded size. */
async function uploadedReport(tenant: string, sizeBytes: number): Promise<string> {
  const clinician = bearer(await token(tenant, ['clinician']));
  const patientId = (
    await api()
      .post('/api/v1/patients')
      .set(clinician)
      .send({ label: `SYN-${randomUUID().slice(0, 8)}` })
      .expect(201)
  ).body.id as string;
  const id = (await api().post('/api/v1/reports').set(clinician).send({ patientId, type: 'structured', filename: 'usage.json', sizeBytes }).expect(201)).body.id as string;
  const reports = app.get(ReportsRepository);
  const record = (await reports.findById(tenant, id))!;
  await commitUpload(reports, record, { principal: 'syn-uploader', sha256: 'a'.repeat(64), contentType: 'text/plain', version: `syn-${id.slice(0, 8)}` });
  return id;
}

beforeAll(async () => {
  app = await createTestApp();
  for (const id of [ALPHA, BETA]) await tenantsOf(app).registerTenant({ id, displayName: id, by: 'test-usage' });
});
afterAll(async () => {
  await app.close();
});

describe('GET /usage', () => {
  it('gives an administrator this month and last month in Puerto Rico time, and storage, in the agreed shape', async () => {
    const res = await usage(ALPHA);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe(NO_STORE);
    const body = usageDtoSchema.parse(res.body);
    expect(body.timeZone).toBe('America/Puerto_Rico');
    expect(body.months.map((m) => m.month)).toEqual(usageWindows(new Date()).map((w) => w.month));
  });

  it("counts the organization's own uploads and storage, never another organization's", async () => {
    const before = usageDtoSchema.parse((await usage(ALPHA)).body);
    const kept = await uploadedReport(ALPHA, 1234);
    const removed = await uploadedReport(ALPHA, 4000);
    await api()
      .delete(`/api/v1/reports/${removed}`)
      .set(bearer(await token(ALPHA, ['clinician'])))
      .expect(204);
    const alpha = usageDtoSchema.parse((await usage(ALPHA)).body);
    expect(alpha.months[0].reportsUploaded - before.months[0].reportsUploaded).toBe(2); // a deleted report was still uploaded
    expect(alpha.storage.reportFiles - before.storage.reportFiles).toBe(1); // ...but is no longer stored
    expect(alpha.storage.reportBytes - before.storage.reportBytes).toBe(1234);
    const beta = usageDtoSchema.parse((await usage(BETA)).body);
    expect(beta.months[0].reportsUploaded).toBe(0);
    expect(beta.storage).toEqual({ reportFiles: 0, reportBytes: 0 });
    expect(kept).not.toBe(removed);
  });

  it('refuses every role but admin (403), and a member with no role', async () => {
    for (const roles of [['reader'], ['clinician'], ['reviewer'], ['clinician', 'reviewer'], []] as Role[][]) {
      const res = await usage(ALPHA, roles);
      expect([roles, res.status]).toEqual([roles, 403]);
      expect(res.body).not.toHaveProperty('months');
    }
  });

  it('refuses an anonymous request (401)', async () => {
    const res = await api().get('/api/v1/usage');
    expect(res.status).toBe(401);
    expect(res.body).not.toHaveProperty('storage');
  });
});
