import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { createTestApp } from './helpers/app';
import { bearer, signToken } from './helpers/tokens';

const PROTECTED = '/api/v1/patients';
let app: NestExpressApplication;

beforeAll(async () => {
  app = await createTestApp();
});
afterAll(async () => {
  await app.close();
});

const get = (headers: Record<string, string> = {}) => request(app.getHttpServer()).get(PROTECTED).set(headers);

describe('authentication (every protected route)', () => {
  it('accepts a valid token', async () => {
    await get(bearer(await signToken({ roles: ['reader'] }))).expect(200);
  });

  it('rejects a missing Authorization header with 401, the stable code, and a Bearer challenge', async () => {
    const res = await get().expect(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(res.headers['www-authenticate']).toBe('Bearer');
  });

  it.each([
    ['wrong scheme', 'Basic dXNlcjpwYXNz'],
    ['no token', 'Bearer'],
    ['extra segments', 'Bearer a b'],
    ['garbage token', 'Bearer not.a.jwt'],
    ['alg=none (unsigned) token', 'Bearer eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJ1c2VyLWEifQ.'],
  ])('rejects %s', async (_name, header) => {
    const res = await get({ Authorization: header }).expect(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it.each([
    ['signed with the wrong secret', () => signToken({ secret: 'a-completely-different-secret-0123456789' })],
    ['expired', () => signToken({ iat: -7200, exp: -3600 })],
    ['issued more than 1 hour ago', () => signToken({ iat: -7200, exp: 3600 })],
    ['wrong issuer', () => signToken({ issuer: 'someone-else' })],
    ['wrong audience', () => signToken({ audience: 'another-api' })],
    ['missing subject', () => signToken({ sub: null })],
    ['empty subject', () => signToken({ sub: '' })],
    ['missing expiry', () => signToken({ exp: null })],
    ['missing issued-at', () => signToken({ iat: null })],
    ['unknown role', () => signToken({ roles: ['superuser'] })],
    ['roles that is not a list', () => signToken({ roles: 'admin' })],
  ])('rejects a token that is %s', async (_name, make) => {
    const res = await get(bearer(await make())).expect(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('gives every rejection the same message, so callers cannot learn why', async () => {
    const messages = new Set<string>();
    for (const token of [
      await signToken({ secret: 'a-completely-different-secret-0123456789' }),
      await signToken({ iat: -7200, exp: -3600 }),
      await signToken({ issuer: 'someone-else' }),
    ]) {
      messages.add((await get(bearer(token)).expect(401)).body.error.message);
    }
    expect(messages.size).toBe(1);
  });

  it('leaves only the health endpoints public', async () => {
    await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    await request(app.getHttpServer()).get('/api/v1/ready').expect(200);
    for (const path of ['/api/v1/patients', '/api/v1/reports', '/api/v1/recommendations']) {
      await request(app.getHttpServer()).get(path).expect(401);
    }
  });
});
