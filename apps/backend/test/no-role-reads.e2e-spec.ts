import { randomUUID } from 'node:crypto';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { IS_PUBLIC_KEY, ROLES_KEY } from '../src/auth/decorators';
import { createTestApp } from './helpers/app';
import { bearer, signToken } from './helpers/tokens';

/**
 * A member with NO role may call only the sign-in permission, the recovery-capability endpoint and sign-out; none exposes clinical records,
 * and sign-out changes only the caller's own membership row (AUTH-03), so a person without a role can still end their own sessions.
 * The route table is walked from the real application, so a new route that forgets @Roles() fails here instead of being open by default.
 */
let app: NestExpressApplication;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
});

const ALLOWED_WITHOUT_A_ROLE = new Set(['GET /api/v1/me', 'GET /api/v1/me/recovery-scope', 'POST /api/v1/me/sign-out']);
const HTTP = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'ALL', 'OPTIONS', 'HEAD'];

interface Route {
  key: string;
  isPublic: boolean;
  roles: unknown;
}

function routes(): Route[] {
  const found: Route[] = [];
  for (const module of app.get(ModulesContainer).values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype as (new (...a: never[]) => unknown) | null;
      if (!controller) continue;
      const base = Reflect.getMetadata(PATH_METADATA, controller) as string | string[] | undefined;
      const prefix = String(Array.isArray(base) ? base[0] : (base ?? '')).replace(/^\/|\/$/g, '');
      for (const name of Object.getOwnPropertyNames(controller.prototype)) {
        const handler = (controller.prototype as Record<string, unknown>)[name];
        if (typeof handler !== 'function') continue;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
        if (method === undefined) continue;
        const sub = String(Reflect.getMetadata(PATH_METADATA, handler) ?? '').replace(/^\/|\/$/g, '');
        const verb = HTTP[method] ?? String(method);
        found.push({
          key: `${verb} /api/v1/${[prefix, sub].filter(Boolean).join('/')}`,
          isPublic: Reflect.getMetadata(IS_PUBLIC_KEY, handler) === true || Reflect.getMetadata(IS_PUBLIC_KEY, controller) === true,
          roles: Reflect.getMetadata(ROLES_KEY, handler) ?? Reflect.getMetadata(ROLES_KEY, controller),
        });
      }
    }
  }
  return found;
}

describe('no route is open to a person with no role, except /me', () => {
  it('every protected route declares the roles it needs', () => {
    const all = routes();
    expect(all.length).toBeGreaterThan(25); // the walk found the real route table
    const open = all
      .filter((r) => !r.isPublic && !(Array.isArray(r.roles) && r.roles.length > 0))
      .map((r) => r.key)
      .sort();
    expect(open).toEqual([...ALLOWED_WITHOUT_A_ROLE].sort());
  });

  it('the walk can see a route that does declare roles, and a public one (control)', () => {
    const all = routes();
    expect(all.find((r) => r.key === 'POST /api/v1/patients')?.roles).toEqual(['clinician']);
    expect(all.find((r) => r.key === 'GET /api/v1/health')?.isPublic).toBe(true);
    expect(all.find((r) => r.key === 'GET /api/v1/patients')?.roles).toEqual(['reader', 'clinician', 'reviewer']);
  });
});

describe('the clinical reads', () => {
  const id = randomUUID();
  const READS: Array<[string, number]> = [
    ['/api/v1/patients', 200],
    [`/api/v1/patients/${id}`, 404],
    ['/api/v1/reports', 200],
    [`/api/v1/reports/${id}`, 404],
  ];
  // These sit behind the lab-report pipeline switch, which is off here: a person who may read gets that answer, never 403.
  const PIPELINE_READS = ['/api/v1/evaluations', `/api/v1/evaluations/${id}`, '/api/v1/cell-disputes', `/api/v1/cell-disputes/${id}`, `/api/v1/captures/${id}`];
  const get = async (path: string, roles?: string[]) =>
    request(app.getHttpServer())
      .get(path)
      .set(bearer(await signToken({ sub: 'user-a', ...(roles ? { roles } : {}) })));

  it.each([...READS.map(([p]) => p), ...PIPELINE_READS])('GET %s is 403 for a member with no role', async (path) => {
    for (const roles of [undefined, []] as const) {
      const res = await get(path, roles as string[] | undefined);
      expect([path, res.status]).toEqual([path, 403]);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
  });

  it.each(READS)('GET %s is %i for every clinical role (controls)', async (path, expected) => {
    for (const role of ['reader', 'clinician', 'reviewer']) {
      expect([path, role, (await get(path, [role])).status]).toEqual([path, role, expected]);
    }
  });

  // DP-1: an organization administrator manages people and reads no clinical data, whatever the record's existence.
  it.each([...READS.map(([p]) => p), ...PIPELINE_READS])('GET %s is 403 for an administrator who holds no clinical role', async (path) => {
    const res = await get(path, ['admin']);
    expect([path, res.status]).toEqual([path, 403]);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it.each(PIPELINE_READS)('GET %s is not 403 for any clinical role', async (path) => {
    for (const role of ['reader', 'clinician', 'reviewer']) {
      expect([path, role, (await get(path, [role])).status]).not.toEqual([path, role, 403]);
    }
  });

  it('a member with no role can still sign in: /me answers with no roles, and the health probes answer', async () => {
    expect((await get('/api/v1/me')).body).toEqual({ roles: [] });
    expect((await get('/api/v1/me/recovery-scope')).body).toEqual({ recoveryScope: expect.stringMatching(/^[0-9a-f]{64}$/) });
    await request(app.getHttpServer()).get('/api/v1/health').expect(200);
  });

  it("the refusal does not depend on the record existing: another tenant's id is 403 for them, not 404", async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/patients/${id}`)
      .set(bearer(await signToken({ sub: 'user-b' })));
    expect(res.status).toBe(403);
  });
});
