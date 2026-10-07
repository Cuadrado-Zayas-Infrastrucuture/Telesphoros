import { SignJWT } from 'jose';
import { TEST_AUDIENCE, TEST_ISSUER, TEST_SECRET } from './env';

export interface TokenOptions {
  sub?: string | null;
  roles?: unknown;
  secret?: string;
  issuer?: string;
  audience?: string;
  /** Seconds relative to now. Negative = in the past. `null` omits the claim. */
  iat?: number | null;
  exp?: number | null;
}

/** Signs a JWT exactly as the HmacTokenVerifier expects, with knobs to break each rule. */
export async function signToken(options: TokenOptions = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims: Record<string, unknown> = {};
  if (options.roles !== undefined) claims.roles = options.roles;
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(options.issuer ?? TEST_ISSUER)
    .setAudience(options.audience ?? TEST_AUDIENCE);
  const sub = options.sub === undefined ? 'user-a' : options.sub;
  if (sub !== null) jwt.setSubject(sub);
  const iat = options.iat === undefined ? 0 : options.iat;
  if (iat !== null) jwt.setIssuedAt(now + iat);
  const exp = options.exp === undefined ? 600 : options.exp;
  if (exp !== null) jwt.setExpirationTime(now + exp);
  return jwt.sign(new TextEncoder().encode(options.secret ?? TEST_SECRET));
}

/** Ready-made callers. user-a and user-b are different owners. */
export const clinicianA = () => signToken({ sub: 'user-a', roles: ['clinician'] });
export const clinicianB = () => signToken({ sub: 'user-b', roles: ['clinician'] });
export const readerA = () => signToken({ sub: 'user-a', roles: ['reader'] });
export const noRolesA = () => signToken({ sub: 'user-a' });

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
