import { createServer as createHttpServer } from 'node:http';
import { createServer, type Server } from 'node:net';
import { DEFAULT_USERS, type FakeIdp, startFakeIdp } from '@telesphoros/fake-idp';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { invalidTokenCases, noTenantCases } from '../../test/helpers/token-rejections';
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
    await expect(verifier().verify(await idp.mintAccessToken({ user: alice }))).resolves.toMatchObject({ sub: alice!.sub, tenantId: 'alpha', roles: ['clinician'] });
    await expect(verifier().verify(await idp.mintAccessToken({ user: bob }))).resolves.toMatchObject({ sub: bob!.sub, tenantId: 'beta', roles: ['reader'] });
    await expect(verifier().verify(await idp.mintAccessToken({ user: carol }))).resolves.toMatchObject({ sub: carol!.sub, tenantId: 'alpha', roles: ['admin'] });
  });

  it('keeps every role group a person holds, so a reviewer who is also a clinician or admin is both', async () => {
    const [gina, hal, ivy] = ['gina', 'hal', 'ivy'].map((n) => DEFAULT_USERS.find((u) => u.email.startsWith(n))!);
    await expect(verifier().verify(await idp.mintAccessToken({ user: gina! }))).resolves.toMatchObject({ sub: gina!.sub, tenantId: 'alpha', roles: ['reviewer'] });
    await expect(verifier().verify(await idp.mintAccessToken({ user: hal! }))).resolves.toMatchObject({ sub: hal!.sub, tenantId: 'alpha', roles: ['clinician', 'reviewer'] });
    await expect(verifier().verify(await idp.mintAccessToken({ user: ivy! }))).resolves.toMatchObject({ sub: ivy!.sub, tenantId: 'alpha', roles: ['admin', 'reviewer'] });
  });

  it('a user in a tenant but with no role group: authenticated with NO roles (least privilege)', async () => {
    await expect(verifier().verify(await idp.mintAccessToken({ user: dave }))).resolves.toMatchObject({ sub: dave!.sub, tenantId: 'beta', roles: [] });
  });

  it('ignores groups it does not know, so an unrecognised group can never grant anything', async () => {
    const token = await idp.mintAccessToken({ user: alice, claims: { 'cognito:groups': ['superuser', 'clinician', 'clinician', 'root', 'tenant:alpha'] } });
    await expect(verifier().verify(token)).resolves.toMatchObject({ sub: alice!.sub, tenantId: 'alpha', roles: ['clinician'] });
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
    await expect(verifier().verify(token)).resolves.toMatchObject({ sub: alice!.sub, tenantId: longest, roles: ['clinician'] });
  });

  it('only a verified token can learn it lacks a tenant: a forged one with no tenant is just "Invalid token"', async () => {
    await rejects(await idp.mintAccessToken({ user: erin, signWith: 'foreign' }));
    await rejects(await idp.mintAccessToken({ user: erin, claims: { client_id: 'someone-else' } }));
  });
});

describe('CognitoTokenVerifier: rejects', () => {
  // The table is shared with the session issuer's spec (DATA-01 T013), which must refuse exactly the same tokens.
  it.each(invalidTokenCases(() => idp, 'app-client'))('%s', async (_name, make) => {
    await rejects(await make());
  });

  it.each(noTenantCases(() => idp))('a genuine token is refused with NoTenantError, not "Invalid token": %s', async (_name, make) => {
    await expect(verifier().verify(await make())).rejects.toBeInstanceOf(NoTenantError);
  });
});

describe('CognitoTokenVerifier: the signing algorithm', () => {
  // Cognito and the fake IdP both publish keys that name RS256, which would refuse another algorithm anyway. This key set names none, so
  // only the verifier's own allow-list stands between an RS384 token (genuine key, valid signature) and acceptance.
  it('accepts RS256 and refuses any other algorithm, even with the genuine key and a valid signature', async () => {
    // A Web Crypto RSA key is bound to one hash, so each algorithm gets its own key, all published without an `alg`.
    const algs = ['RS256', 'RS384', 'RS512'];
    const pairs = new Map(await Promise.all(algs.map(async (alg) => [alg, await generateKeyPair(alg, { extractable: true })] as const)));
    const jwks = JSON.stringify({ keys: await Promise.all(algs.map(async (alg) => ({ ...(await exportJWK(pairs.get(alg)!.publicKey)), kid: alg, use: 'sig' }))) });
    const server = createHttpServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end(jwks));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as { port: number };
      const v = verifier({ jwksUri: `http://127.0.0.1:${port}/jwks.json` });
      const sign = (alg: string) =>
        new SignJWT({ token_use: 'access', client_id: 'app-client', 'cognito:groups': ['tenant:alpha', 'clinician'] })
          .setProtectedHeader({ alg, kid: alg })
          .setSubject(alice!.sub)
          .setIssuer(idp.issuer)
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(pairs.get(alg)!.privateKey);
      await expect(v.verify(await sign('RS256'))).resolves.toMatchObject({ sub: alice!.sub, tenantId: 'alpha' }); // control: the key and claims are good
      await rejects(await sign('RS384'), v);
      await rejects(await sign('RS512'), v);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('CognitoTokenVerifier: system actors', () => {
  it('refuses a genuine, correctly signed access token whose subject is a system actor', async () => {
    await rejects(await idp.mintAccessToken({ user: { ...alice!, sub: 'system:uploads.sweep' } }));
    await expect(verifier().verify(await idp.mintAccessToken({ user: { ...alice!, sub: 'systemic' } }))).resolves.toMatchObject({ sub: 'systemic' });
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
