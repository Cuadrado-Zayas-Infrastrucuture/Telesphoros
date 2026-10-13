import { createHash, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { ObjectStorage } from '../src/object-storage/object-storage';
import { InMemorySecurityEvents, SecurityEvents } from '../src/security-events/security-events';
import { createTestApp, membershipOf, securityEventsOf } from './helpers/app';
import { bearer, signToken } from './helpers/tokens';

/**
 * M1.6: what the application records. These apps run WITHOUT the token mirror, so each person exists only because the test granted them. The
 * events are read the way an auditor would see them: from the store, never from the response.
 */
const TENANT = 'tenant-user-a';
const OPERATOR = { by: 'operator-test', reason: 'test' };
const BYTES = Buffer.from('##fileformat=VCFv4.3\n#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO\n');
const sha = createHash('sha256').update(BYTES).digest('hex');
const person = () => `person-${randomUUID().slice(0, 8)}`;
const token = (sub: string, options: Parameters<typeof signToken>[0] = {}) => signToken({ sub, tenant: TENANT, ...options });

let app: NestExpressApplication;
const api = (target: NestExpressApplication = app) => request(target.getHttpServer());

beforeAll(async () => {
  app = await createTestApp({ membershipFromTokens: false });
});
afterAll(async () => {
  await app.close();
});

/** Registers and uploads a small file for `sub`, so a download link can be requested. Returns the report id. */
async function uploadedReport(target: NestExpressApplication, sub: string): Promise<string> {
  const t = bearer(await token(sub));
  const patientId = (await api(target).post('/api/v1/patients').set(t).send({ label: `SYN-${randomUUID().slice(0, 8)}` }).expect(201)).body.id;
  const reportId = (await api(target).post('/api/v1/reports').set(t).send({ patientId, type: 'vcf', filename: 'inert.vcf', sizeBytes: BYTES.length }).expect(201)).body.id;
  const revision = (await api(target).get(`/api/v1/reports/${reportId}/upload-state`).set(t).expect(200)).body.revision;
  const attempt = (await api(target).post(`/api/v1/reports/${reportId}/upload-attempts`).set(t).send({ requestId: randomUUID(), revision, contentType: 'text/x-vcf', sha256: sha }).expect(201)).body;
  await api(target).put(`/api/v1/reports/${reportId}/upload-attempts/${attempt.attemptId}/bytes`).set(t).set('X-Upload-Revision', attempt.revision).set('Content-Type', 'text/x-vcf').send(BYTES).expect(200);
  return reportId;
}

const mine = async (sub: string, target: NestExpressApplication = app) => (await securityEventsOf(target)).filter((e) => e.actorRef === sub);

describe('refused access is recorded, once a minute per person and reason', () => {
  it('a person with no membership, a removed person and a revoked token each leave one event with the right reason', async () => {
    const stranger = person();
    expect((await api().get('/api/v1/me').set(bearer(await token(stranger)))).status).toBe(403);
    expect(await mine(stranger)).toEqual([expect.objectContaining({ eventType: 'access.refused', outcome: 'refused', tenantId: TENANT, subjectKind: 'person', subjectRef: stranger, details: { reason: 'no-membership' } })]);

    const leaver = person();
    const ops = membershipOf(app);
    await ops.grant({ tenantId: TENANT, sub: leaver, roles: ['clinician'], ...OPERATOR });
    const old = await token(leaver, { iat: -30 });
    await ops.remove({ tenantId: TENANT, sub: leaver, revokedAt: new Date(Date.now() - 20_000), ...OPERATOR });
    expect((await api().get('/api/v1/me').set(bearer(old))).status).toBe(403);
    await ops.grant({ tenantId: TENANT, sub: leaver, roles: ['clinician'], revokedAt: new Date(Date.now() - 10_000), ...OPERATOR });
    expect((await api().get('/api/v1/me').set(bearer(old))).status).toBe(401);
    expect((await mine(leaver)).filter((e) => e.eventType === 'access.refused').map((e) => e.details.reason)).toEqual(['removed', 'token-revoked']);
  });

  it('a flood of refused requests from one person records one event, and another person or reason records another', async () => {
    const flooder = person();
    const t = bearer(await token(flooder));
    for (let i = 0; i < 25; i++) await api().get('/api/v1/me').set(t).expect(403);
    expect((await mine(flooder)).filter((e) => e.eventType === 'access.refused')).toHaveLength(1);
    const other = person();
    await api().get('/api/v1/me').set(bearer(await token(other))).expect(403);
    expect((await mine(other)).filter((e) => e.eventType === 'access.refused')).toHaveLength(1);
  });

  it('an allowed request records nothing (control)', async () => {
    const member = person();
    await membershipOf(app).grant({ tenantId: TENANT, sub: member, roles: ['reader'], ...OPERATOR });
    await api().get('/api/v1/me').set(bearer(await token(member))).expect(200);
    expect((await mine(member)).filter((e) => e.eventType === 'access.refused')).toEqual([]);
  });
});

describe('a file link is never issued without its event', () => {
  it('records who was given a link to which report, with identifiers only', async () => {
    const sub = person();
    await membershipOf(app).grant({ tenantId: TENANT, sub, roles: ['clinician'], ...OPERATOR });
    const reportId = await uploadedReport(app, sub);
    const t = await token(sub);
    const res = await api().get(`/api/v1/reports/${reportId}/download-url`).set(bearer(t)).expect(200);
    const events = (await mine(sub)).filter((e) => e.eventType === 'file.link.issued');
    expect(events).toEqual([expect.objectContaining({ outcome: 'succeeded', tenantId: TENANT, actorRef: sub, subjectKind: 'report', subjectRef: reportId, details: expect.objectContaining({ reportId, ttlSeconds: expect.any(Number) }) })]);
    // Nothing that could be used to fetch the file, or that names it, is in the event.
    const stored = JSON.stringify(events);
    expect(stored).not.toContain(res.body.url);
    expect(stored).not.toContain(t);
    expect(stored).not.toMatch(/https?:|inert\.vcf|SYN-|X-Amz|Signature/i);
  });

  it('a reader gets no link and no event (refused before anything is recorded)', async () => {
    const sub = person();
    await membershipOf(app).grant({ tenantId: TENANT, sub, roles: ['reader'], ...OPERATOR });
    const reportId = await uploadedReport(app, (await (async () => { const owner = person(); await membershipOf(app).grant({ tenantId: TENANT, sub: owner, roles: ['clinician'], ...OPERATOR }); return owner; })()));
    await api().get(`/api/v1/reports/${reportId}/download-url`).set(bearer(await token(sub))).expect(403);
    expect((await mine(sub)).filter((e) => e.eventType === 'file.link.issued')).toEqual([]);
  });

  it('when the event cannot be recorded the answer is 503, the object store is never asked for a link, and it recovers', async () => {
    const failing = new InMemorySecurityEvents();
    const guarded = await createTestApp({ membershipFromTokens: false, overrides: [{ provide: SecurityEvents, useValue: failing }] });
    try {
      const sub = person();
      await membershipOf(guarded).grant({ tenantId: TENANT, sub, roles: ['clinician'], ...OPERATOR });
      const reportId = await uploadedReport(guarded, sub);
      const makeLink = jest.spyOn(guarded.get(ObjectStorage), 'createDownloadUrl');
      failing.failWith = new Error('the event store is down');
      const refused = await api(guarded).get(`/api/v1/reports/${reportId}/download-url`).set(bearer(await token(sub)));
      expect(refused.status).toBe(503);
      expect(refused.body.error.code).toBe('SERVICE_UNAVAILABLE');
      expect(JSON.stringify(refused.body)).not.toMatch(/event store/);
      expect(makeLink).not.toHaveBeenCalled();
      failing.failWith = undefined;
      await api(guarded).get(`/api/v1/reports/${reportId}/download-url`).set(bearer(await token(sub))).expect(200);
      expect(makeLink).toHaveBeenCalledTimes(1);
    } finally {
      await guarded.close();
    }
  });
});
