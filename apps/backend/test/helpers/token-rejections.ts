import type { FakeIdp } from '@telesphoros/fake-idp';
import { SignJWT } from 'jose';

type Case = [name: string, mint: () => Promise<string>];

/**
 * Every access token the Cognito verifier must refuse as "Invalid token", as one table. The verifier's own spec iterates it, and so does the session
 * issuer's (DATA-01 T013): the issuer must reject exactly what the API rejects, so both read the same cases and a case added here binds both.
 * The identity provider starts in a `beforeAll`, so the table takes a getter and mints lazily.
 */
export function invalidTokenCases(getIdp: () => FakeIdp, clientId: string): Case[] {
  const idp = getIdp;
  const user = (name: string) => idp().users.find((u) => u.email.startsWith(name))!;
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return [
    ['an ID token (the API takes access tokens only)', () => idp().mintIdToken()],
    ['an otherwise-valid token whose token_use is "id" (isolates the token_use check from the missing client_id)', () => idp().mintAccessToken({ claims: { token_use: 'id' } })],
    ['a token with no token_use', () => idp().mintAccessToken({ omit: ['token_use'] })],
    ['a token for a different app client', () => idp().mintAccessToken({ claims: { client_id: 'someone-elses-client' } })],
    ['a token with no client_id', () => idp().mintAccessToken({ omit: ['client_id'] })],
    ['a token from a different issuer', () => idp().mintAccessToken({ claims: { iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_Other' } })],
    ['an expired token', () => idp().mintAccessToken({ issuedAtOffsetSeconds: -7200, expiresInSeconds: 60 })],
    ['a token issued more than an hour ago', () => idp().mintAccessToken({ issuedAtOffsetSeconds: -4000, expiresInSeconds: 7200 })],
    ['a token with no subject', () => idp().mintAccessToken({ omit: ['sub'] })],
    ['a token with an empty subject', () => idp().mintAccessToken({ claims: { sub: '' } })],
    ['a token with no expiry', () => idp().mintAccessToken({ omit: ['exp'] })],
    ['a token with no issued-at', () => idp().mintAccessToken({ omit: ['iat'] })],
    ['a forgery signed by a key we do not publish (same key id)', () => idp().mintAccessToken({ signWith: 'foreign' })],
    ['a token naming a key id the pool never published', () => idp().mintAccessToken({ kid: 'not-a-real-key' })],
    ['a genuine, correctly signed token whose subject is a system actor', () => idp().mintAccessToken({ user: { ...user('alice'), sub: 'system:uploads.sweep' } })],
    ['a forgery whose user has no tenant group (only a verified token may learn it lacks one)', () => idp().mintAccessToken({ user: user('erin'), signWith: 'foreign' })],
    [
      'the algorithm-confusion attack: HS256 signed with the PUBLIC key as the secret',
      async () => {
        const jwk = idp().publicJwks().keys[0]!;
        return new SignJWT({ sub: user('alice').sub, iss: idp().issuer, client_id: clientId, token_use: 'access', 'cognito:groups': ['admin'] })
          .setProtectedHeader({ alg: 'HS256', kid: jwk.kid })
          .setIssuedAt()
          .setExpirationTime('10m')
          .sign(new TextEncoder().encode(JSON.stringify(jwk)));
      },
    ],
    [
      'an unsigned (alg "none") token claiming to be an admin',
      async () => {
        const now = Math.floor(Date.now() / 1000);
        return `${part({ alg: 'none', typ: 'JWT' })}.${part({ sub: user('alice').sub, iss: idp().issuer, client_id: clientId, token_use: 'access', iat: now, exp: now + 600, 'cognito:groups': ['admin'] })}.`;
      },
    ],
    ...['', 'abc', 'a.b.c', 'a.b', '....'].map((garbage): Case => [`garbage input (${JSON.stringify(garbage)})`, async () => garbage]),
  ];
}

/** Genuine, correctly signed tokens whose user does not belong to exactly one tenant: the verifier answers `NoTenantError` (a 403), not "Invalid token". */
export function noTenantCases(getIdp: () => FakeIdp): Case[] {
  const idp = getIdp;
  const user = (name: string) => idp().users.find((u) => u.email.startsWith(name))!;
  return [
    ['a user with a role but no tenant group', () => idp().mintAccessToken({ user: user('erin') })],
    ['a user in two tenants', () => idp().mintAccessToken({ user: user('frank') })],
    ['a repeated tenant group', () => idp().mintAccessToken({ user: user('alice'), claims: { 'cognito:groups': ['clinician', 'tenant:alpha', 'tenant:alpha'] } })],
    ['a groups claim of the wrong shape', () => idp().mintAccessToken({ user: user('alice'), claims: { 'cognito:groups': 'admin' } })],
    ['a malformed tenant id (upper case)', () => idp().mintAccessToken({ user: user('alice'), claims: { 'cognito:groups': ['clinician', 'tenant:Alpha'] } })],
  ];
}
