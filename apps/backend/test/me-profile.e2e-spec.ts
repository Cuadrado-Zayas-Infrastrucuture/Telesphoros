import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { meDtoSchema, meProfileDtoSchema, type Role } from '@telesphoros/shared-types';
import { createTestApp, membershipOf, tenantsOf } from './helpers/app';
import { bearer, signToken } from './helpers/tokens';

/**
 * GET /me/profile: the caller's own organization, for display (Settings). Runs on every storage tier: on PostgreSQL the read goes through
 * the application role, so row-level security (policy tenants_own) is what keeps one organization's name from another.
 */
const suffix = randomUUID().slice(0, 8);
const ALPHA = { id: `tenant-alpha-${suffix}`, name: 'Synthetic Clinic Alpha' };
const BETA = { id: `tenant-beta-${suffix}`, name: 'Synthetic Pharmacy Beta' };
let app: NestExpressApplication;
const api = (target: NestExpressApplication = app) => request(target.getHttpServer());
const person = () => `person-${randomUUID().slice(0, 8)}`;
const profile = async (tenant: string, roles: Role[] = ['reader'], target = app, sub = person()) =>
  api(target)
    .get('/api/v1/me/profile')
    .set(bearer(await signToken({ sub, tenant, roles })));

beforeAll(async () => {
  app = await createTestApp();
  for (const tenant of [ALPHA, BETA]) await tenantsOf(app).registerTenant({ id: tenant.id, displayName: tenant.name, by: 'test-me-profile' });
});
afterAll(async () => {
  await app.close();
});

describe('GET /me/profile', () => {
  it('returns the caller’s own organization name, and nothing else', async () => {
    const res = await profile(ALPHA.id);
    expect(res.status).toBe(200);
    expect(meProfileDtoSchema.parse(res.body)).toEqual({ organization: { name: ALPHA.name } });
  });

  it('never shows another organization’s name: each caller sees only their own', async () => {
    const [alpha, beta] = await Promise.all([profile(ALPHA.id, ['clinician']), profile(BETA.id, ['clinician'])]);
    expect(alpha.body).toEqual({ organization: { name: ALPHA.name } });
    expect(beta.body).toEqual({ organization: { name: BETA.name } });
  });

  it('answers any active member, including one with no role and an administrator', async () => {
    for (const roles of [[], ['admin']] as Role[][]) {
      const res = await profile(ALPHA.id, roles);
      expect([roles, res.status, res.body]).toEqual([roles, 200, { organization: { name: ALPHA.name } }]);
    }
  });

  it('refuses an anonymous request (401) without naming any organization', async () => {
    const res = await api().get('/api/v1/me/profile');
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toMatch(/Synthetic Clinic Alpha|Synthetic Pharmacy Beta/);
  });

  it('refuses a verified token for someone who is not a member (403), without naming the organization', async () => {
    const strict = await createTestApp({ membershipFromTokens: false });
    try {
      await tenantsOf(strict)
        .registerTenant({ id: ALPHA.id, displayName: ALPHA.name, by: 'test-me-profile' })
        .catch(() => undefined);
      const stranger = person();
      const refused = await profile(ALPHA.id, ['clinician'], strict, stranger);
      expect(refused.status).toBe(403);
      expect(JSON.stringify(refused.body)).not.toContain(ALPHA.name);
      await membershipOf(strict).grant({ tenantId: ALPHA.id, sub: stranger, roles: ['reader'], by: 'test-me-profile', reason: 'test' });
      expect((await profile(ALPHA.id, ['reader'], strict, stranger)).body).toEqual({ organization: { name: ALPHA.name } });
    } finally {
      await strict.close();
    }
  });

  it('leaves GET /me exactly as old clients expect: roles only', async () => {
    const res = await api()
      .get('/api/v1/me')
      .set(bearer(await signToken({ sub: person(), tenant: ALPHA.id, roles: ['reader'] })));
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['roles']);
    expect(meDtoSchema.parse(res.body)).toEqual({ roles: ['reader'] });
  });
});
