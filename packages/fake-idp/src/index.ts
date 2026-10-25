/**
 * TEST-ONLY OpenID Connect provider that imitates Amazon Cognito closely enough to exercise our
 * token verification and our login flow for real: genuine RSA keys, a published key set, the
 * authorization-code flow with mandatory PKCE, single-use codes, exact redirect-URI matching,
 * Cognito-shaped access/ID tokens, a Cognito-style /logout, and switches for key rotation and outages.
 *
 * It is NOT Cognito and proves nothing about Cognito's own behaviour. It must never be deployed:
 * it signs in anyone who clicks a button.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { type CryptoKey, exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';

export interface FakeUser {
  sub: string;
  email: string;
  groups: string[];
}

/**
 * Groups work like Cognito's: role groups plus exactly one "tenant:<id>" group per user.
 * alice and carol share a tenant (so tests can prove members see each other's records); bob and
 * dave are in another. erin has a role but no tenant, and frank is in two tenants: both must be refused.
 */
export const DEFAULT_USERS: FakeUser[] = [
  { sub: '11111111-1111-4111-8111-111111111111', email: 'alice@example.test', groups: ['clinician', 'tenant:alpha'] },
  { sub: '22222222-2222-4222-8222-222222222222', email: 'bob@example.test', groups: ['reader', 'tenant:beta'] },
  { sub: '33333333-3333-4333-8333-333333333333', email: 'carol@example.test', groups: ['admin', 'tenant:alpha'] },
  { sub: '44444444-4444-4444-8444-444444444444', email: 'dave@example.test', groups: ['tenant:beta'] },
  { sub: '55555555-5555-4555-8555-555555555555', email: 'erin@example.test', groups: ['clinician'] },
  { sub: '66666666-6666-4666-8666-666666666666', email: 'frank@example.test', groups: ['clinician', 'tenant:alpha', 'tenant:beta'] },
  // Reviewers, alone and in combination: the backend must read the whole set of groups, never a "highest" role.
  { sub: '77777777-7777-4777-8777-777777777777', email: 'gina@example.test', groups: ['reviewer', 'tenant:alpha'] },
  { sub: '88888888-8888-4888-8888-888888888888', email: 'hal@example.test', groups: ['clinician', 'reviewer', 'tenant:alpha'] },
  { sub: '99999999-9999-4999-8999-999999999999', email: 'ivy@example.test', groups: ['admin', 'reviewer', 'tenant:alpha'] },
];

export interface FakeIdpOptions {
  host?: string;
  /** 0 picks a free port. */
  port?: number;
  clientId?: string;
  redirectUris?: string[];
  logoutUris?: string[];
  users?: FakeUser[];
  accessTokenTtlSeconds?: number;
}

export interface MintOptions {
  /** Defaults to the first user. */
  user?: FakeUser;
  /** Replace or add claims (e.g. `{ client_id: 'someone-else' }`). */
  claims?: Record<string, unknown>;
  /** Remove claims entirely. */
  omit?: string[];
  expiresInSeconds?: number;
  /** Shifts `iat` (and `exp` with it), e.g. -7200 for a token issued two hours ago. */
  issuedAtOffsetSeconds?: number;
  /** Sign with a key the published key set does NOT contain (same `kid`), i.e. a forgery. */
  signWith?: 'current' | 'foreign';
  kid?: string;
}

export interface FakeIdp {
  issuer: string;
  jwksUri: string;
  clientId: string;
  users: FakeUser[];
  stop(): Promise<void>;
  /** Adds a new signing key. Old keys stay published unless `retireOld` is true (a real rotation overlap). */
  rotateKey(options?: { retireOld?: boolean }): Promise<void>;
  /** While true, the key-set endpoint answers 503. */
  setJwksDown(down: boolean): void;
  publicJwks(): { keys: JWK[] };
  mintAccessToken(options?: MintOptions): Promise<string>;
  mintIdToken(options?: MintOptions): Promise<string>;
}

interface SigningKey {
  kid: string;
  privateKey: CryptoKey;
  publicJwk: JWK;
}

async function newSigningKey(): Promise<SigningKey> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const kid = randomUUID();
  return { kid, privateKey, publicJwk: { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' } };
}

const base64url = (buffer: Buffer) => buffer.toString('base64url');
const pkceChallenge = (verifier: string) => base64url(createHash('sha256').update(verifier).digest());
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

export async function startFakeIdp(options: FakeIdpOptions = {}): Promise<FakeIdp> {
  const host = options.host ?? '127.0.0.1';
  const clientId = options.clientId ?? 'fake-client-id';
  const users = options.users ?? DEFAULT_USERS;
  const redirectUris = options.redirectUris ?? [];
  const logoutUris = options.logoutUris ?? [];
  const accessTtl = options.accessTokenTtlSeconds ?? 900;
  const allowedOrigins = new Set([...redirectUris, ...logoutUris].map((uri) => new URL(uri).origin));

  let signing = [await newSigningKey()];
  let current = signing[0]!;
  const foreign = await newSigningKey();
  let jwksDown = false;
  let issuer = '';
  const codes = new Map<string, { redirectUri: string; challenge: string; sub: string; nonce?: string; expires: number }>();

  async function sign(claims: Record<string, unknown>, mint: MintOptions): Promise<string> {
    const key = mint.signWith === 'foreign' ? foreign : current;
    return new SignJWT(claims as Record<string, unknown>).setProtectedHeader({ alg: 'RS256', kid: mint.kid ?? key.kid, typ: 'JWT' }).sign(key.privateKey);
  }

  function baseClaims(mint: MintOptions, tokenUse: 'access' | 'id', ttl: number) {
    const user = mint.user ?? users[0]!;
    const iat = Math.floor(Date.now() / 1000) + (mint.issuedAtOffsetSeconds ?? 0);
    const claims: Record<string, unknown> = {
      sub: user.sub,
      iss: issuer,
      token_use: tokenUse,
      auth_time: iat,
      iat,
      exp: iat + (mint.expiresInSeconds ?? ttl),
      jti: randomUUID(),
      ...(user.groups.length > 0 ? { 'cognito:groups': user.groups } : {}),
    };
    if (tokenUse === 'access') {
      Object.assign(claims, { client_id: clientId, scope: 'openid email', username: user.sub, origin_jti: randomUUID() });
    } else {
      Object.assign(claims, { aud: clientId, email: user.email, 'cognito:username': user.sub, email_verified: true });
    }
    Object.assign(claims, mint.claims ?? {});
    for (const name of mint.omit ?? []) delete claims[name];
    return claims;
  }

  const mintAccessToken = (mint: MintOptions = {}) => sign(baseClaims(mint, 'access', accessTtl), mint);
  const mintIdToken = (mint: MintOptions = {}) => sign(baseClaims(mint, 'id', accessTtl), mint);

  function cors(req: IncomingMessage, res: ServerResponse) {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'content-type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
  }

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const fail = (res: ServerResponse, error: string, status = 400) => json(res, status, { error });
  const sessionSub = (req: IncomingMessage) => /(?:^|;\s*)fake_idp_session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];

  /** Validates the authorize request exactly as strictly as Cognito does for the parts we rely on. */
  function checkAuthorize(params: URLSearchParams): string | undefined {
    if (params.get('client_id') !== clientId) return 'unknown client_id';
    const redirectUri = params.get('redirect_uri') ?? '';
    if (!redirectUris.includes(redirectUri)) return 'redirect_uri is not registered (exact match required)';
    if (params.get('response_type') !== 'code') return 'only response_type=code is supported';
    if (params.get('code_challenge_method') !== 'S256' || !params.get('code_challenge')) return 'PKCE (S256) is required';
    if (!params.get('state')) return 'state is required';
    return undefined;
  }

  const server: Server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', issuer || 'http://localhost');
      cors(req, res);
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (url.pathname === '/.well-known/openid-configuration') {
        return json(res, 200, {
          issuer,
          authorization_endpoint: `${issuer}/oauth2/authorize`,
          token_endpoint: `${issuer}/oauth2/token`,
          jwks_uri: `${issuer}/.well-known/jwks.json`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          scopes_supported: ['openid', 'email'],
          code_challenge_methods_supported: ['S256'],
        });
      }

      if (url.pathname === '/.well-known/jwks.json') {
        if (jwksDown) return fail(res, 'key set unavailable', 503);
        return json(res, 200, { keys: signing.map((k) => k.publicJwk) });
      }

      if (url.pathname === '/oauth2/authorize' && req.method === 'GET') {
        const problem = checkAuthorize(url.searchParams);
        if (problem) return fail(res, problem);
        const sub = sessionSub(req);
        if (sub && users.some((u) => u.sub === sub)) {
          // An existing sign-in session: return straight to the app (this is the "silent" re-login).
          const code = randomUUID();
          codes.set(code, {
            redirectUri: url.searchParams.get('redirect_uri')!,
            challenge: url.searchParams.get('code_challenge')!,
            sub,
            nonce: url.searchParams.get('nonce') ?? undefined,
            expires: Date.now() + 60_000,
          });
          const back = new URL(url.searchParams.get('redirect_uri')!);
          back.searchParams.set('code', code);
          back.searchParams.set('state', url.searchParams.get('state')!);
          res.writeHead(302, { Location: back.toString() });
          res.end();
          return;
        }
        const hidden = [...url.searchParams].map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`).join('');
        const buttons = users
          .map(
            (u) =>
              `<li><button type="submit" name="user" value="${escapeHtml(u.sub)}">Sign in as ${escapeHtml(u.email.split('@')[0]!)} (${escapeHtml(u.groups.join(', ') || 'no role')})</button></li>`,
          )
          .join('');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(
          `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fake sign-in</title></head><body><main><h1>Fake identity provider (test only)</h1><form method="post" action="/oauth2/login">${hidden}<ul>${buttons}</ul></form></main></body></html>`,
        );
        return;
      }

      if (url.pathname === '/oauth2/login' && req.method === 'POST') {
        const form = await readForm(req);
        const sub = form.get('user') ?? '';
        if (!users.some((u) => u.sub === sub)) return fail(res, 'unknown user');
        const params = new URLSearchParams(form);
        params.delete('user');
        res.writeHead(302, {
          'Set-Cookie': `fake_idp_session=${sub}; Path=/; HttpOnly; SameSite=Lax`,
          Location: `/oauth2/authorize?${params.toString()}`,
        });
        res.end();
        return;
      }

      if (url.pathname === '/oauth2/token' && req.method === 'POST') {
        const form = await readForm(req);
        if (form.get('grant_type') !== 'authorization_code') return fail(res, 'unsupported_grant_type');
        if (form.get('client_id') !== clientId) return fail(res, 'invalid_client');
        const code = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? ''); // single use, even when the rest of the request is wrong
        if (!code || code.expires < Date.now()) return fail(res, 'invalid_grant');
        if (code.redirectUri !== form.get('redirect_uri')) return fail(res, 'invalid_grant');
        if (pkceChallenge(form.get('code_verifier') ?? '') !== code.challenge) return fail(res, 'invalid_grant');
        const user = users.find((u) => u.sub === code.sub)!;
        return json(res, 200, {
          access_token: await mintAccessToken({ user }),
          // A real provider echoes the nonce from the authorize request into the ID token.
          id_token: await mintIdToken({ user, ...(code.nonce ? { claims: { nonce: code.nonce } } : {}) }),
          refresh_token: `fake-refresh-${randomUUID()}`,
          token_type: 'Bearer',
          expires_in: accessTtl,
        });
      }

      if (url.pathname === '/logout' && req.method === 'GET') {
        if (url.searchParams.get('client_id') !== clientId) return fail(res, 'unknown client_id');
        const target = url.searchParams.get('logout_uri') ?? '';
        if (!logoutUris.includes(target)) return fail(res, 'logout_uri is not registered');
        res.writeHead(302, { 'Set-Cookie': 'fake_idp_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax', Location: target });
        res.end();
        return;
      }

      fail(res, 'not found', 404);
    } catch (error) {
      fail(res, error instanceof Error ? error.message : 'bad request');
    }
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, host, resolve));
  const address = server.address();
  if (typeof address !== 'object' || !address) throw new Error('fake idp failed to bind');
  issuer = `http://${host}:${address.port}`;

  return {
    issuer,
    jwksUri: `${issuer}/.well-known/jwks.json`,
    clientId,
    users,
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
    async rotateKey({ retireOld = false } = {}) {
      current = await newSigningKey();
      signing = retireOld ? [current] : [...signing, current];
    },
    setJwksDown(down) {
      jwksDown = down;
    },
    publicJwks: () => ({ keys: signing.map((k) => k.publicJwk) }),
    mintAccessToken,
    mintIdToken,
  };
}
