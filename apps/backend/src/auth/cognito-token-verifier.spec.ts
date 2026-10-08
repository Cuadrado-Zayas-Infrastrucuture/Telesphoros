import { createServer, type Server } from 'node:net';
import { DEFAULT_USERS, type FakeIdp, startFakeIdp } from '@telesphoros/fake-idp';
import { SignJWT } from 'jose';
import { CognitoTokenVerifier } from './cognito-token-verifier';
import { InvalidTokenError, NoTenantError } from './token-verifier';

let idp: FakeIdp;
beforeAll(async () => {
  idp = await startFakeIdp({ clientId: 'app-client' });
});
afterAll(() => idp.stop());

const verifier = (over: { cooldownMs?: number; timeoutMs?: number; jwksUri?: string } = {}) =>
  new CognitoTokenVerifier({ issuer: idp.issuer, clientId: 'app-client', cooldownMs: 0, ...over });
const [alice, bob, carol, dave, erin, frank] = DEFAULT_USERS;
const rejects = async (token: string, v = verifier()) => {
  const error = await v.verify(token).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(InvalidTokenError);
  expect((error as Error).message).toBe('Invalid token'); // one generic message: callers learn nothing
};

describe('CognitoTokenVerifier: accepts', () => {
  it('a valid access token, mapping cognito:groups to roles', async () => {
    await expect(verifier().verify(await idp.mintAccessToken({ user: alice }))).resolves.toEqual({ sub: alice!.sub, tenantId: 'alpha', roles: ['clinician'] });
    await expect(verifier().verify(await idp.mintAccessToken({ user: bob }))).resolves.toEqual({ sub: bob!.sub, tenantId: 'beta', roles: ['reader'] });
    await expect(verifier().verify(await idp.mintAccessToken({ user: carol }))).resolves.toEqual({ sub: carol!.sub, tenantId: 'alpha', roles: ['admin'] });
  });

  it('a user in a tenant but with no role group: authenticated with NO roles (least privilege)', async () => {
    await expect(verifier().verify(await idp.mintAccessToken({ user: dave }))).resolves.toEqual({ sub: dave!.sub, tenantId: 'beta', roles: [] });
  });

  it('ignores groups it does not know, so an unrecognised group can never grant anything', async () => {
    const token = await idp.mintAccessToken({ user: alice, claims: { 'cognito:groups': ['superuser', 'clinician', 'clinician', 'root', 'tenant:alpha'] } });
    await expect(verifier().verify(token)).resolves.toEqual({ sub: alice!.sub, tenantId: 'alpha', roles: ['clinician'] });
  });

  it('treats a groups claim of the wrong shape as no groups at all: no roles and no tenant, so the user is refused', async () => {
    const token = await idp.mintAccessToken({ user: alice, claims: { 'cognito:groups': 'admin' } });
    await expect(verifier().verify(token)).rejects.toBeInstanceOf(NoTenantError);
  });
});

describe('CognitoTokenVerifier: the tenant (exactly one "tenant:<id>" group)', () => {
  const refused = async (token: string) => {
    await expect(verifier().verify(token)).rejects.toBeInstanceOf(NoTenantError);
  };

  it('refuses a genuine token whose user has a role but no tenant group', async () => {
    await refused(await idp.mintAccessToken({ user: erin }));
  });

  it('refuses a user in two tenants rather than picking one, and a repeated group', async () => {
    await refused(await idp.mintAccessToken({ user: frank }));
    await refused(await idp.mintAccessToken({ user: alice, claims: { 'cognito:groups': ['clinician', 'tenant:alpha', 'tenant:alpha'] } }));
  });

  it.each([
    ['empty id', 'tenant:'],
    ['upper case', 'tenant:Alpha'],
    ['a space', 'tenant:al pha'],
    ['a slash', 'tenant:a/b'],
    ['a leading dash', 'tenant:-alpha'],
    ['64 characters', `tenant:${'a'.repeat(64)}`],
  ])('refuses a malformed tenant id (%s)', async (_name, group) => {
    await refused(await idp.mintAccessToken({ user: alice, claims: { 'cognito:groups': ['clinician', group] } }));
  });

  it('accepts the longest valid id (63 characters) and ignores a group that merely resembles the prefix', async () => {
    const longest = 'a'.repeat(63);
    const token = await idp.mintAccessToken({ user: alice, claims: { 'cognito:groups': ['clinician', `tenant:${longest}`, 'tenants', 'tenant'] } });
    await expect(verifier().verify(token)).resolves.toEqual({ sub: alice!.sub, tenantId: longest, roles: ['clinician'] });
  });

  it('only a verified token can learn it lacks a tenant: a forged one with no tenant is just "Invalid token"', async () => {
    await rejects(await idp.mintAccessToken({ user: erin, signWith: 'foreign' }));
    await rejects(await idp.mintAccessToken({ user: erin, claims: { client_id: 'someone-else' } }));
  });
});

describe('CognitoTokenVerifier: rejects', () => {
  it.each([
    ['an ID token (the API takes access tokens only)', () => idp.mintIdToken()],
    ['an otherwise-valid token whose token_use is "id" (isolates the token_use check from the missing client_id)', () => idp.mintAccessToken({ claims: { token_use: 'id' } })],
    ['a token with no token_use', () => idp.mintAccessToken({ omit: ['token_use'] })],
    ['a token for a different app client', () => idp.mintAccessToken({ claims: { client_id: 'someone-elses-client' } })],
    ['a token with no client_id', () => idp.mintAccessToken({ omit: ['client_id'] })],
    ['a token from a different issuer', () => idp.mintAccessToken({ claims: { iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Other' } })],
    ['an expired token', () => idp.mintAccessToken({ issuedAtOffsetSeconds: -7200, expiresInSeconds: 60 })],
    ['a token issued more than an hour ago', () => idp.mintAccessToken({ issuedAtOffsetSeconds: -4000, expiresInSeconds: 7200 })],
    ['a token with no subject', () => idp.mintAccessToken({ omit: ['sub'] })],
    ['a token with an empty subject', () => idp.mintAccessToken({ claims: { sub: '' } })],
    ['a token with no expiry', () => idp.mintAccessToken({ omit: ['exp'] })],
    ['a token with no issued-at', () => idp.mintAccessToken({ omit: ['iat'] })],
    ['a forgery signed by a key we do not publish (same key id)', () => idp.mintAccessToken({ signWith: 'foreign' })],
    ['a token naming a key id the pool never published', () => idp.mintAccessToken({ kid: 'not-a-real-key' })],
  ])('%s', async (_name, make) => {
    await rejects(await make());
  });

  it('the algorithm-confusion attack: HS256 signed with the PUBLIC key as the secret', async () => {
    const jwk = idp.publicJwks().keys[0]!;
    const forged = await new SignJWT({ sub: alice!.sub, iss: idp.issuer, client_id: 'app-client', token_use: 'access', 'cognito:groups': ['admin'] })
      .setProtectedHeader({ alg: 'HS256', kid: jwk.kid })
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(new TextEncoder().encode(JSON.stringify(jwk)));
    await rejects(forged);
  });

  it('an unsigned (alg "none") token claiming to be an admin', async () => {
    const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    await rejects(`${part({ alg: 'none', typ: 'JWT' })}.${part({ sub: alice!.sub, iss: idp.issuer, client_id: 'app-client', token_use: 'access', iat: now, exp: now + 600, 'cognito:groups': ['admin'] })}.`);
  });

  it.each(['', 'abc', 'a.b.c', 'a.b', '....'])('garbage input (%j)', async (garbage) => {
    await rejects(garbage);
  });
});

describe('CognitoTokenVerifier: the published key set', () => {
  it('picks up a rotated key, and tokens signed by the old key keep working during the overlap', async () => {
    const v = verifier();
    const before = await idp.mintAccessToken();
    await v.verify(before); // primes the cache with the old key only
    await idp.rotateKey();
    const after = await idp.mintAccessToken();
    await expect(v.verify(after)).resolves.toBeDefined(); // unknown kid triggers one refetch
    await expect(v.verify(before)).resolves.toBeDefined();
  });

  it('rejects a token whose key was retired after rotation', async () => {
    const old = await idp.mintAccessToken();
    await idp.rotateKey({ retireOld: true });
    await rejects(old);
  });

  it('fails CLOSED (401, quickly) when the key set is down and nothing is cached', async () => {
    const v = verifier({ timeoutMs: 500 });
    const token = await idp.mintAccessToken();
    idp.setJwksDown(true);
    try {
      const started = Date.now();
      await rejects(token, v);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      idp.setJwksDown(false);
    }
    await expect(v.verify(token)).resolves.toBeDefined(); // and it recovers on its own
  });

  it('keeps verifying with cached keys through an outage (an outage must not log everyone out)', async () => {
    const v = verifier();
    const token = await idp.mintAccessToken();
    await v.verify(token); // cache primed
    idp.setJwksDown(true);
    try {
      await expect(v.verify(token)).resolves.toBeDefined();
    } finally {
      idp.setJwksDown(false);
    }
  });

  it('gives up on a key-set server that never answers (a bounded wait, not a hang)', async () => {
    const silent: Server = createServer(() => undefined); // accepts connections, never replies
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const port = (silent.address() as { port: number }).port;
    try {
      const started = Date.now();
      await rejects(await idp.mintAccessToken(), verifier({ timeoutMs: 300, jwksUri: `http://127.0.0.1:${port}/jwks.json` }));
      expect(Date.now() - started).toBeLessThan(2500);
    } finally {
      silent.close();
    }
  });

  it('does not accept keys from a key set that does not match the issuer it was given', async () => {
    const other = await startFakeIdp({ clientId: 'app-client' });
    try {
      // Tokens from `other` carry other's issuer, so they fail against a verifier for `idp` even if keys were shared.
      await rejects(await other.mintAccessToken());
    } finally {
      await other.stop();
    }
  });
});
