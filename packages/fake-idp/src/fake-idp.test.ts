import { createHash, randomBytes } from 'node:crypto';
import { createLocalJWKSet, type JWK, jwtVerify } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FakeIdp, startFakeIdp } from './index';

const REDIRECT = 'http://127.0.0.1:4173/auth/callback';
const LOGOUT = 'http://127.0.0.1:4173/signed-out';
let idp: FakeIdp;
beforeAll(async () => {
  idp = await startFakeIdp({ clientId: 'test-client', redirectUris: [REDIRECT], logoutUris: [LOGOUT] });
});
afterAll(() => idp.stop());

const verifier = () => randomBytes(32).toString('base64url');
const challenge = (v: string) => createHash('sha256').update(v).digest('base64url');
const authorize = (extra: Record<string, string> = {}, cookie?: string) => {
  const params = new URLSearchParams({
    client_id: 'test-client', redirect_uri: REDIRECT, response_type: 'code', scope: 'openid email', state: 's1',
    code_challenge: challenge('x'), code_challenge_method: 'S256', ...extra,
  });
  return fetch(`${idp.issuer}/oauth2/authorize?${params}`, { redirect: 'manual', headers: cookie ? { cookie } : {} });
};
async function loginAndGetCode(codeVerifier: string) {
  const params = { code_challenge: challenge(codeVerifier) };
  const form = new URLSearchParams({
    client_id: 'test-client', redirect_uri: REDIRECT, response_type: 'code', scope: 'openid email', state: 's1',
    code_challenge: params.code_challenge, code_challenge_method: 'S256', user: idp.users[0]!.sub,
  });
  const login = await fetch(`${idp.issuer}/oauth2/login`, { method: 'POST', body: form, redirect: 'manual' });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const back = await fetch(new URL(login.headers.get('location')!, idp.issuer), { redirect: 'manual', headers: { cookie } });
  return { code: new URL(back.headers.get('location')!).searchParams.get('code')!, cookie };
}
const exchange = (body: Record<string, string>) =>
  fetch(`${idp.issuer}/oauth2/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', client_id: 'test-client', redirect_uri: REDIRECT, ...body }) });

describe('fake IdP behaves like a strict OIDC provider', () => {
  it('publishes discovery and keys, and its tokens verify against them', async () => {
    const meta = (await (await fetch(`${idp.issuer}/.well-known/openid-configuration`)).json()) as { issuer: string };
    expect(meta.issuer).toBe(idp.issuer);
    const keys = createLocalJWKSet((await (await fetch(idp.jwksUri)).json()) as { keys: JWK[] });
    const { payload } = await jwtVerify(await idp.mintAccessToken(), keys, { issuer: idp.issuer });
    expect(payload).toMatchObject({ token_use: 'access', client_id: 'test-client', 'cognito:groups': ['clinician'] });
  });

  it('rejects an unregistered redirect_uri, missing PKCE and missing state', async () => {
    expect((await authorize({ redirect_uri: 'http://evil.test/cb' })).status).toBe(400);
    expect((await authorize({ code_challenge: '' })).status).toBe(400);
    expect((await authorize({ code_challenge_method: 'plain' })).status).toBe(400);
    expect((await authorize({ state: '' })).status).toBe(400);
    expect((await authorize({ client_id: 'other' })).status).toBe(400);
  });

  it('completes code + PKCE, issues the code once, and verifies the verifier', async () => {
    const v = verifier();
    const { code } = await loginAndGetCode(v);
    const ok = await exchange({ code, code_verifier: v });
    expect(ok.status).toBe(200);
    const tokens = (await ok.json()) as { token_type: string };
    expect(tokens.token_type).toBe('Bearer');
    expect((await exchange({ code, code_verifier: v })).status).toBe(400); // replay

    const second = await loginAndGetCode(v);
    expect((await exchange({ code: second.code, code_verifier: verifier() })).status).toBe(400); // wrong verifier
    const third = await loginAndGetCode(v);
    expect((await exchange({ code: third.code, code_verifier: v, redirect_uri: 'http://evil.test/cb' })).status).toBe(400);
  });

  it('echoes the nonce from the authorize request into the ID token', async () => {
    const v = verifier();
    const form = new URLSearchParams({
      client_id: 'test-client', redirect_uri: REDIRECT, response_type: 'code', scope: 'openid email', state: 's1',
      code_challenge: challenge(v), code_challenge_method: 'S256', nonce: 'n-0S6_WzA2Mj', user: idp.users[0]!.sub,
    });
    const login = await fetch(`${idp.issuer}/oauth2/login`, { method: 'POST', body: form, redirect: 'manual' });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const back = await fetch(new URL(login.headers.get('location')!, idp.issuer), { redirect: 'manual', headers: { cookie } });
    const code = new URL(back.headers.get('location')!).searchParams.get('code')!;
    const tokens = (await (await exchange({ code, code_verifier: v })).json()) as { id_token: string };
    expect(JSON.parse(Buffer.from(tokens.id_token.split('.')[1]!, 'base64url').toString()).nonce).toBe('n-0S6_WzA2Mj');
  });

  it('signs in silently when a session exists, and logout ends it', async () => {
    const { cookie } = await loginAndGetCode(verifier());
    const again = await authorize({}, cookie);
    expect(again.status).toBe(302);
    expect(new URL(again.headers.get('location')!).searchParams.get('code')).toBeTruthy();
    const out = await fetch(`${idp.issuer}/logout?client_id=test-client&logout_uri=${encodeURIComponent(LOGOUT)}`, { redirect: 'manual' });
    expect(out.status).toBe(302);
    expect(out.headers.get('set-cookie')).toMatch(/Max-Age=0/);
    expect((await fetch(`${idp.issuer}/logout?client_id=test-client&logout_uri=http%3A%2F%2Fevil.test`, { redirect: 'manual' })).status).toBe(400);
  });

  it('rotates keys (old tokens still verify while overlapping) and can simulate a key-set outage', async () => {
    const old = await idp.mintAccessToken();
    await idp.rotateKey();
    const fresh = await idp.mintAccessToken();
    const keys = createLocalJWKSet(idp.publicJwks());
    await expect(jwtVerify(old, keys)).resolves.toBeDefined();
    await expect(jwtVerify(fresh, keys)).resolves.toBeDefined();
    idp.setJwksDown(true);
    expect((await fetch(idp.jwksUri)).status).toBe(503);
    idp.setJwksDown(false);
    expect((await fetch(idp.jwksUri)).status).toBe(200);
  });

  it('can mint forgeries and malformed tokens on demand', async () => {
    const keys = createLocalJWKSet(idp.publicJwks());
    await expect(jwtVerify(await idp.mintAccessToken({ signWith: 'foreign' }), keys)).rejects.toThrow();
    const noGroups = await idp.mintAccessToken({ omit: ['cognito:groups'] });
    expect(JSON.parse(Buffer.from(noGroups.split('.')[1]!, 'base64url').toString())['cognito:groups']).toBeUndefined();
  });
});
