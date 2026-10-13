import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { Database } from '../src/db/database';
import { MembershipAdminError, type MembershipAdmin, type MembershipRecord } from '../src/membership/membership';
import { InMemoryMembershipRepository, MembershipRepository } from '../src/storage/membership.repository';
import { PostgresMembershipRepository } from '../src/storage/postgres/membership.repository';
import { createTestApp, membershipOf, usingPostgres } from './helpers/app';
import { createEphemeralDatabase, type EphemeralDatabase } from './helpers/database';
import { bearer, signToken } from './helpers/tokens';

/**
 * Authority is the membership row, not the token (M1.5). These apps run WITHOUT the helper that mirrors token claims into membership, so
 * every person here exists only because the test granted them, and every change is made the way an operator would make it.
 */
const TENANT = 'tenant-membership';
const OPERATOR = { by: 'operator-test', reason: 'test' };
let app: NestExpressApplication;
const api = (target: NestExpressApplication = app) => request(target.getHttpServer());
const sub = () => `person-${randomUUID().slice(0, 8)}`;
const token = (person: string, options: Parameters<typeof signToken>[0] = {}) => signToken({ sub: person, tenant: TENANT, ...options });
const me = async (person: string, options: Parameters<typeof signToken>[0] = {}, target = app) => api(target).get('/api/v1/me').set(bearer(await token(person, options)));
const createPatient = async (person: string, options: Parameters<typeof signToken>[0] = {}, target = app) =>
  api(target).post('/api/v1/patients').set(bearer(await token(person, options))).send({ label: `SYN-${randomUUID().slice(0, 8)}` });

beforeAll(async () => {
  app = await createTestApp({ membershipFromTokens: false });
});
afterAll(async () => {
  await app.close();
});

describe('who a person is allowed to be comes from the membership row', () => {
  it('refuses a verified token for a person with no membership (403), and lets them in once they are granted', async () => {
    const person = sub();
    expect((await me(person, { roles: ['clinician'] })).status).toBe(403);
    await membershipOf(app).grant({ tenantId: TENANT, sub: person, roles: ['clinician'], ...OPERATOR });
    const res = await me(person);
    expect(res.status).toBe(200);
    expect(res.body.roles).toEqual(['clinician']);
  });

  it('takes the roles from the row, not the token: a token claiming admin and clinician for a reader is a reader', async () => {
    const person = sub();
    await membershipOf(app).grant({ tenantId: TENANT, sub: person, roles: ['reader'], ...OPERATOR });
    const res = await me(person, { roles: ['admin', 'clinician'] });
    expect(res.body.roles).toEqual(['reader']);
    expect((await createPatient(person, { roles: ['admin', 'clinician'] })).status).toBe(403);
  });

  it('a token with no roles gets the roles the row grants (control for the above)', async () => {
    const person = sub();
    await membershipOf(app).grant({ tenantId: TENANT, sub: person, roles: ['clinician'], ...OPERATOR });
    expect((await createPatient(person)).status).toBe(201);
  });

  it('takes the organization from the token AND the row: a person active only in another organization is refused', async () => {
    const person = sub();
    await membershipOf(app).grant({ tenantId: 'tenant-elsewhere', sub: person, roles: ['clinician'], ...OPERATOR });
    expect((await me(person)).status).toBe(403);
    expect((await me(person, { tenant: 'tenant-elsewhere' })).status).toBe(200);
  });
});

describe('removal and role changes take effect on the very next request, with the same token', () => {
  it('removing a person refuses their next read and write', async () => {
    const person = sub();
    const admin = membershipOf(app);
    await admin.grant({ tenantId: TENANT, sub: person, roles: ['clinician'], ...OPERATOR });
    const old = await token(person);
    expect((await api().get('/api/v1/patients').set(bearer(old))).status).toBe(200);
    await admin.remove({ tenantId: TENANT, sub: person, ...OPERATOR });
    expect((await api().get('/api/v1/patients').set(bearer(old))).status).toBe(403);
    expect((await api().post('/api/v1/patients').set(bearer(old)).send({ label: 'SYN-AFTER' })).status).toBe(403);
  });

  it('a role downgrade changes authority at once: the same token can read but no longer write', async () => {
    const person = sub();
    const admin = membershipOf(app);
    await admin.grant({ tenantId: TENANT, sub: person, roles: ['clinician'], ...OPERATOR });
    const t = await token(person);
    expect((await api().post('/api/v1/patients').set(bearer(t)).send({ label: `SYN-${randomUUID().slice(0, 8)}` })).status).toBe(201);
    await admin.setRoles({ tenantId: TENANT, sub: person, roles: ['reader'], ...OPERATOR });
    expect((await api().post('/api/v1/patients').set(bearer(t)).send({ label: `SYN-${randomUUID().slice(0, 8)}` })).status).toBe(403);
    expect((await api().get('/api/v1/patients').set(bearer(t))).status).toBe(200);
  });

  it('reviewer is additive and comes from the row too', async () => {
    const person = sub();
    await membershipOf(app).grant({ tenantId: TENANT, sub: person, roles: ['clinician', 'reviewer'], ...OPERATOR });
    expect((await me(person)).body.roles).toEqual(['clinician', 'reviewer']);
  });
});

describe('revocation: a token issued before the revocation instant stays refused', () => {
  const secondsAgo = (n: number) => new Date(Date.now() - n * 1000);

  it('after removal and reinstatement the OLD token is refused (401) but a NEW one works', async () => {
    const person = sub();
    const admin = membershipOf(app);
    await admin.grant({ tenantId: TENANT, sub: person, roles: ['clinician'], ...OPERATOR });
    const old = await token(person, { iat: -30 });
    expect((await api().get('/api/v1/me').set(bearer(old))).status).toBe(200);
    await admin.remove({ tenantId: TENANT, sub: person, revokedAt: secondsAgo(20), ...OPERATOR });
    expect((await api().get('/api/v1/me').set(bearer(old))).status).toBe(403);
    await admin.grant({ tenantId: TENANT, sub: person, roles: ['clinician'], revokedAt: secondsAgo(10), ...OPERATOR });
    const refused = await api().get('/api/v1/me').set(bearer(old));
    expect(refused.status).toBe(401);
    expect(refused.body.error.code).toBe('UNAUTHORIZED');
    expect((await me(person)).status).toBe(200); // a token issued now
  });

  it('revoking sessions refuses tokens issued before it, keeps the roles, and a fresh token works', async () => {
    const person = sub();
    const admin = membershipOf(app);
    await admin.grant({ tenantId: TENANT, sub: person, roles: ['reader'], ...OPERATOR });
    const old = await token(person, { iat: -30 });
    await admin.revokeSessions({ tenantId: TENANT, sub: person, revokedAt: secondsAgo(20), ...OPERATOR });
    expect((await api().get('/api/v1/me').set(bearer(old))).status).toBe(401);
    expect((await me(person)).body.roles).toEqual(['reader']);
  });

  it('a revocation instant never moves backwards: an earlier one recorded later changes nothing', async () => {
    const person = sub();
    const admin = membershipOf(app);
    await admin.grant({ tenantId: TENANT, sub: person, roles: ['reader'], ...OPERATOR });
    const first = await admin.revokeSessions({ tenantId: TENANT, sub: person, revokedAt: secondsAgo(5), ...OPERATOR });
    const second = await admin.revokeSessions({ tenantId: TENANT, sub: person, revokedAt: secondsAgo(50), ...OPERATOR });
    expect(second.tokensValidAfter).toBe(first.tokensValidAfter);
    expect(second.version).toBeGreaterThan(first.version);
  });
});

describe('the operator rules', () => {
  const ops = () => membershipOf(app);

  it('a person is active in one organization at a time', async () => {
    const person = sub();
    await ops().grant({ tenantId: TENANT, sub: person, roles: ['reader'], ...OPERATOR });
    await expect(ops().grant({ tenantId: 'tenant-other', sub: person, roles: ['reader'], ...OPERATOR })).rejects.toMatchObject({ failure: 'in-another-organization' });
    await ops().remove({ tenantId: TENANT, sub: person, ...OPERATOR });
    await expect(ops().grant({ tenantId: 'tenant-other', sub: person, roles: ['reader'], ...OPERATOR })).resolves.toMatchObject({ status: 'active' }); // control
  });

  it('refuses granting an active member again, changing or removing someone who is not active, and unknown roles', async () => {
    const person = sub();
    await expect(ops().setRoles({ tenantId: TENANT, sub: person, roles: ['reader'], ...OPERATOR })).rejects.toMatchObject({ failure: 'not-active' });
    await expect(ops().remove({ tenantId: TENANT, sub: person, ...OPERATOR })).rejects.toMatchObject({ failure: 'not-active' });
    await ops().grant({ tenantId: TENANT, sub: person, roles: ['reader'], ...OPERATOR });
    await expect(ops().grant({ tenantId: TENANT, sub: person, roles: ['reader'], ...OPERATOR })).rejects.toMatchObject({ failure: 'already-active' });
    await expect(ops().setRoles({ tenantId: TENANT, sub: person, roles: ['superuser' as never], ...OPERATOR })).rejects.toBeInstanceOf(MembershipAdminError);
    await ops().remove({ tenantId: TENANT, sub: person, ...OPERATOR });
    await expect(ops().remove({ tenantId: TENANT, sub: person, ...OPERATOR })).rejects.toMatchObject({ failure: 'not-active' });
  });

  it('every change moves the version; showing a person changes nothing', async () => {
    const person = sub();
    const granted = await ops().grant({ tenantId: TENANT, sub: person, roles: ['reader'], ...OPERATOR });
    const changed = await ops().setRoles({ tenantId: TENANT, sub: person, roles: ['clinician'], ...OPERATOR });
    expect(granted.version).toBe(1);
    expect(changed.version).toBe(2);
    expect(await ops().show(TENANT, person)).toEqual(changed);
    expect(await ops().show(TENANT, 'nobody')).toBeUndefined();
  });
});

describe('when authority cannot be established, nothing is done', () => {
  it('a failing membership lookup answers 503 on a protected route (not 401, which would loop sign-in), never lets the request through, and recovers', async () => {
    // The real store, with a switch that makes every lookup fail the way a lost database connection would.
    class SwitchableLookups extends MembershipRepository {
      failLookups?: Error;
      inner!: MembershipRepository;
      async find(tenantId: string, who: string): Promise<MembershipRecord | undefined> {
        if (this.failLookups) throw this.failLookups;
        return this.inner.find(tenantId, who);
      }
    }
    const store = new SwitchableLookups();
    const guarded = await createTestApp({ membershipFromTokens: false, overrides: [{ provide: MembershipRepository, useValue: store }] });
    try {
      const memory = new InMemoryMembershipRepository();
      store.inner = usingPostgres() ? new PostgresMembershipRepository(guarded.get(Database)) : memory;
      const operator: MembershipAdmin = usingPostgres() ? membershipOf(guarded) : memory;
      const person = sub();
      await operator.grant({ tenantId: TENANT, sub: person, roles: ['clinician'], ...OPERATOR });
      const t = await token(person);
      expect((await api(guarded).post('/api/v1/patients').set(bearer(t)).send({ label: 'SYN-BEFORE' })).status).toBe(201);

      store.failLookups = new Error('connect ECONNREFUSED 10.0.0.1:5432 password=hunter2');
      const read = await api(guarded).get('/api/v1/patients').set(bearer(t));
      const write = await api(guarded).post('/api/v1/patients').set(bearer(t)).send({ label: 'SYN-DURING' });
      for (const res of [read, write]) {
        expect(res.status).toBe(503);
        expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
        expect(JSON.stringify(res.body)).not.toMatch(/hunter2|ECONNREFUSED|10\.0\.0\.1/); // nothing internal reaches the caller
      }
      // The public probes do not depend on membership.
      expect((await api(guarded).get('/api/v1/health')).status).toBe(200);

      store.failLookups = undefined;
      const list = await api(guarded).get('/api/v1/patients').set(bearer(t));
      expect(list.status).toBe(200);
      expect(list.body.data.map((p: { label: string }) => p.label)).toEqual(['SYN-BEFORE']); // the write made during the outage never happened
    } finally {
      await guarded.close();
    }
  });
});

describe('two API instances sharing one store (replicas)', () => {
  let db: EphemeralDatabase | undefined;
  let a: NestExpressApplication;
  let b: NestExpressApplication;

  beforeAll(async () => {
    if (usingPostgres()) {
      db = await createEphemeralDatabase();
      a = await createTestApp({ membershipFromTokens: false, postgresUrl: db.appUrl });
      b = await createTestApp({ membershipFromTokens: false, postgresUrl: db.appUrl });
    } else {
      const shared = new InMemoryMembershipRepository();
      a = await createTestApp({ membershipFromTokens: false, overrides: [{ provide: MembershipRepository, useValue: shared }] });
      b = await createTestApp({ membershipFromTokens: false, overrides: [{ provide: MembershipRepository, useValue: shared }] });
    }
  });
  afterAll(async () => {
    await a?.close();
    await b?.close();
    await db?.drop();
  });

  it('a removal made through one is refused on BOTH the next time the old token is used', async () => {
    const person = sub();
    await membershipOf(a).grant({ tenantId: TENANT, sub: person, roles: ['clinician'], ...OPERATOR });
    const old = await token(person);
    expect((await api(a).get('/api/v1/me').set(bearer(old))).status).toBe(200);
    expect((await api(b).get('/api/v1/me').set(bearer(old))).status).toBe(200);

    await membershipOf(b).remove({ tenantId: TENANT, sub: person, ...OPERATOR });

    expect((await api(a).get('/api/v1/me').set(bearer(old))).status).toBe(403);
    expect((await api(b).get('/api/v1/me').set(bearer(old))).status).toBe(403);
    expect((await api(a).post('/api/v1/patients').set(bearer(old)).send({ label: 'SYN-LATE-A' })).status).toBe(403);
    expect((await api(b).post('/api/v1/patients').set(bearer(old)).send({ label: 'SYN-LATE-B' })).status).toBe(403);
  });

  it('a role downgrade and a session revocation are likewise seen by both', async () => {
    const person = sub();
    await membershipOf(a).grant({ tenantId: TENANT, sub: person, roles: ['clinician'], ...OPERATOR });
    const old = await token(person, { iat: -30 });
    await membershipOf(a).setRoles({ tenantId: TENANT, sub: person, roles: ['reader'], ...OPERATOR });
    for (const target of [a, b]) expect((await api(target).get('/api/v1/me').set(bearer(old))).body.roles).toEqual(['reader']);
    await membershipOf(b).revokeSessions({ tenantId: TENANT, sub: person, revokedAt: new Date(Date.now() - 20_000), ...OPERATOR });
    for (const target of [a, b]) expect((await api(target).get('/api/v1/me').set(bearer(old))).status).toBe(401);
  });
});
