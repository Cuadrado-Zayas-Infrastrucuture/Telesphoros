import { jwtVerify } from 'jose';
import { roleSchema, tenantIdSchema } from '@telesphoros/shared-types';
import { z } from 'zod';
import type { Env } from '../config/env';
import type { Principal } from './principal';

/** Anything that can turn a bearer token into a Principal. Phase 4 adds the real provider's verifier. */
export abstract class TokenVerifier {
  abstract verify(token: string): Promise<Principal>;
}

export class InvalidTokenError extends Error {}

/**
 * The token is genuine but the user does not belong to exactly one tenant. That is a 403 (known
 * user, not allowed in), not a 401. Thrown only AFTER the signature and claims have been verified,
 * so it tells an attacker with a forged token nothing.
 */
export class NoTenantError extends Error {
  constructor() {
    super('The user does not belong to exactly one tenant');
  }
}

const rolesClaim = z.array(roleSchema).max(10);
const subjectClaim = z.string().min(1).max(128);

/**
 * DEVELOPMENT/TEST ONLY: verifies HS256 tokens signed with a shared secret. loadEnv() refuses to
 * start in production, so this can never serve real traffic.
 * Enforces: signature, issuer, audience, expiry, an issued-at no older than 1 hour, a non-empty
 * subject, known roles, and a valid `tenant` claim. Anything else is rejected with one generic error.
 */
export class HmacTokenVerifier extends TokenVerifier {
  private readonly key: Uint8Array;

  constructor(private readonly env: Pick<Env, 'JWT_SECRET' | 'JWT_ISSUER' | 'JWT_AUDIENCE'>) {
    super();
    this.key = new TextEncoder().encode(env.JWT_SECRET);
  }

  async verify(token: string): Promise<Principal> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: ['HS256'],
        issuer: this.env.JWT_ISSUER,
        audience: this.env.JWT_AUDIENCE,
        requiredClaims: ['sub', 'exp', 'iat'],
        maxTokenAge: '1h',
      });
      const sub = subjectClaim.parse(payload.sub);
      // A missing roles claim means "no roles" (least privilege); a malformed one is rejected.
      const roles = payload.roles === undefined ? [] : rolesClaim.parse(payload.roles);
      // The development token carries the tenant directly; a missing or malformed one is "no tenant".
      const tenant = tenantIdSchema.safeParse(payload.tenant);
      if (!tenant.success) throw new NoTenantError();
      return { sub, tenantId: tenant.data, roles };
    } catch (error) {
      if (error instanceof NoTenantError) throw error;
      // intentional: one generic error, so callers cannot learn WHY a token was rejected
      throw new InvalidTokenError('Invalid token');
    }
  }
}
