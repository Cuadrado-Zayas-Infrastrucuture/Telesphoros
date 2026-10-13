import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { type FakeIdp, startFakeIdp } from '@telesphoros/fake-idp';
import { errorResponseSchema, meDtoSchema } from '@telesphoros/shared-types';
import request from 'supertest';
import { CognitoTokenVerifier } from '../src/auth/cognito-token-verifier';
import { createTestApp } from './helpers/app';
import { bearer } from './helpers/tokens';

const ORIGIN = 'https://app.example.test';
let idp: FakeIdp;
let app: NestExpressApplication;
beforeAll(async () => {
  idp = await startFakeIdp({ clientId: 'spa-client' });
  app = await createTestApp({
    tokenVerifier: new CognitoTokenVerifier({ issuer: idp.issuer, clientId: 'spa-client', cooldownMs: 0 }),
    corsOrigins: [ORIGIN],
  });
});
afterAll(async () => {
  await app.close();
  await idp.stop();
});

type Name = 'alice' | 'bob' | 'carol' | 'dave' | 'erin' | 'frank';
const user = (name: Name) => idp.users.find((u) => u.email.startsWith(name))!;
const token = (name: Name) => idp.mintAccessToken({ user: user(name) });
const api = () => request(app.getHttpServer());

describe('the API, authenticating real RS256 Cognito-shaped tokens', () => {
  it('roles come from cognito:groups: clinician and admin write, reader reads, a user with no role group can neither write nor read', async () => {
    const label = () => `SYN-${randomUUID().slice(0, 8)}`;
    await api().post('/api/v1/patients').set(bearer(await token('alice'))).send({ label: label() }).expect(201);
    await api().post('/api/v1/patients').set(bearer(await token('carol'))).send({ label: label() }).expect(201);
    for (const who of ['bob', 'dave'] as const) {
      const res = await api().post('/api/v1/patients').set(bearer(await token(who))).send({ label: label() }).expect(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
      await api().get('/api/v1/patients').set(bearer(await token(who))).expect(who === 'bob' ? 200 : 403);
    }
  });

  it('one tenant can never see or touch another tenant’s records (the tenant group becomes the scope, RLS binds on PostgreSQL)', async () => {
    const created = (await api().post('/api/v1/patients').set(bearer(await token('alice'))).send({ label: `SYN-${randomUUID().slice(0, 8)}` }).expect(201)).body;
    const bobsList = await api().get('/api/v1/patients').set(bearer(await token('bob'))).expect(200);
    expect(bobsList.body.data.map((p: { id: string }) => p.id)).not.toContain(created.id);
    await api().get(`/api/v1/patients/${created.id}`).set(bearer(await token('bob'))).expect(404);
    await api().get(`/api/v1/patients/${created.id}`).set(bearer(await token('alice'))).expect(200);
  });

  it('members of one tenant share records: alice and carol (tenant alpha) see each other’s, bob (beta) sees neither', async () => {
    const created = (await api().post('/api/v1/patients').set(bearer(await token('alice'))).send({ label: `SYN-${randomUUID().slice(0, 8)}` }).expect(201)).body;
    await api().get(`/api/v1/patients/${created.id}`).set(bearer(await token('carol'))).expect(200);
    await api().get(`/api/v1/patients/${created.id}`).set(bearer(await token('bob'))).expect(404);
  });

  it('a signed-in user without exactly one tenant group is refused with 403: erin has none, frank has two', async () => {
    for (const who of ['erin', 'frank'] as const) {
      for (const path of ['/api/v1/me', '/api/v1/patients']) {
        const res = await api().get(path).set(bearer(await token(who))).expect(403);
        expect(errorResponseSchema.safeParse(res.body).success).toBe(true);
        expect(res.body.error.code).toBe('FORBIDDEN');
      }
    }
  });

  it('GET /me returns the caller’s roles and nothing else', async () => {
    const res = await api().get('/api/v1/me').set(bearer(await token('alice'))).expect(200);
    expect(res.body).toEqual({ roles: ['clinician'] });
    expect(meDtoSchema.safeParse(res.body).success).toBe(true);
    expect((await api().get('/api/v1/me').set(bearer(await token('dave'))).expect(200)).body).toEqual({ roles: [] });
    await api().get('/api/v1/me').expect(401);
  });

  it.each([
    ['an ID token', () => idp.mintIdToken({ user: user('carol') })],
    ['a token for another app client', () => idp.mintAccessToken({ user: user('carol'), claims: { client_id: 'other' } })],
    ['a forgery', () => idp.mintAccessToken({ user: user('carol'), signWith: 'foreign' })],
    ['an expired token', () => idp.mintAccessToken({ user: user('carol'), issuedAtOffsetSeconds: -7200, expiresInSeconds: 60 })],
  ])('refuses %s with the standard 401 envelope', async (_name, make) => {
    const res = await api().get('/api/v1/me').set(bearer(await make())).expect(401);
    expect(errorResponseSchema.safeParse(res.body).success).toBe(true);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('answers 401 (not 500) while the key set is unreachable and the key is not cached', async () => {
    const fresh = await createTestApp({ tokenVerifier: new CognitoTokenVerifier({ issuer: idp.issuer, clientId: 'spa-client', timeoutMs: 400 }) });
    try {
      const t = await token('alice');
      idp.setJwksDown(true);
      const res = await request(fresh.getHttpServer()).get('/api/v1/me').set(bearer(t));
      expect(res.status).toBe(401);
      idp.setJwksDown(false);
      await request(fresh.getHttpServer()).get('/api/v1/me').set(bearer(t)).expect(200);
    } finally {
      idp.setJwksDown(false);
      await fresh.close();
    }
  });
});

describe('CORS: an explicit allowlist, nothing else', () => {
  it('answers an allowed origin’s preflight without needing a token, and names exactly what is allowed', async () => {
    const res = await api()
      .options('/api/v1/patients')
      .set('Origin', ORIGIN)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization,content-type')
      .expect(204);
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(res.headers['access-control-allow-headers']).toMatch(/authorization/i);
    expect(res.headers['access-control-allow-methods']).toBe('GET,POST,PUT,PATCH,DELETE');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined(); // bearer tokens, never cookies
    expect(res.headers['access-control-max-age']).toBe('600');
  });

  it('lets the browser read X-Request-Id on a real response from an allowed origin', async () => {
    const res = await api().get('/api/v1/me').set('Origin', ORIGIN).set(bearer(await token('alice'))).expect(200);
    expect(res.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(res.headers['access-control-expose-headers']).toMatch(/X-Request-Id/i);
  });

  it.each(['https://evil.example.test', 'http://app.example.test', 'https://app.example.test.evil.test', 'null'])(
    'sends NO CORS headers to %s, so the browser blocks it',
    async (origin) => {
      const pre = await api().options('/api/v1/patients').set('Origin', origin).set('Access-Control-Request-Method', 'GET');
      expect(pre.headers['access-control-allow-origin']).toBeUndefined();
      const real = await api().get('/api/v1/me').set('Origin', origin).set(bearer(await token('alice')));
      expect(real.headers['access-control-allow-origin']).toBeUndefined();
    },
  );

  it('sends no CORS headers at all when no origins are configured (the default)', async () => {
    const closed = await createTestApp();
    try {
      const res = await request(closed.getHttpServer()).options('/api/v1/health').set('Origin', ORIGIN).set('Access-Control-Request-Method', 'GET');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      await closed.close();
    }
  });
});
