import { Logger } from '@nestjs/common';
import { type Role, roleSchema, tenantFromGroups } from '@telesphoros/shared-types';
import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from 'jose';
import { z } from 'zod';
import { InvalidTokenError, NoTenantError, subjectClaim, type TokenIdentity, TokenVerifier } from './token-verifier';

export interface CognitoVerifierOptions {
  /** `https://cognito-idp.<region>.amazonaws.com/<user pool id>` */
  issuer: string;
  /** The app client id. Cognito access tokens carry it as `client_id` (they have no `aud`). */
  clientId: string;
  /** Defaults to `<issuer>/.well-known/jwks.json`. */
  jwksUri?: string;
  /** How long to wait for the key set before giving up (and answering 401). */
  timeoutMs?: number;
  /** Minimum gap between key-set refetches triggered by an unknown key id (limits abuse). */
  cooldownMs?: number;
}


/**
 * Verifies Amazon Cognito ACCESS tokens (the API never accepts ID tokens).
 *
 * Checks: RS256 only (never HS256, never "none": a token signed with the public key as an HMAC
 * secret is rejected), signature against the pool's published key set, issuer, `token_use=access`,
 * `client_id`, expiry, and an issued-at no older than 1 hour. Roles come from `cognito:groups`;
 * a group we do not know is ignored, so an unrecognised group can never grant anything.
 *
 * If the key set cannot be fetched the answer is 401 (fail closed), never a 500 and never "allow".
 * Keys already cached keep verifying through a short outage.
 */
export class CognitoTokenVerifier extends TokenVerifier {
  private readonly logger = new Logger('CognitoTokenVerifier');
  private readonly keys: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly options: CognitoVerifierOptions) {
    super();
    this.keys = createRemoteJWKSet(new URL(options.jwksUri ?? `${options.issuer}/.well-known/jwks.json`), {
      timeoutDuration: options.timeoutMs ?? 3000,
      cooldownDuration: options.cooldownMs ?? 10_000,
      cacheMaxAge: 10 * 60 * 1000,
    });
  }

  async verify(token: string): Promise<TokenIdentity> {
    try {
      const { payload } = await jwtVerify(token, this.keys, {
        algorithms: ['RS256'],
        issuer: this.options.issuer,
        requiredClaims: ['sub', 'exp', 'iat'],
        maxTokenAge: '1h',
      });
      if (payload.token_use !== 'access') throw new InvalidTokenError('not an access token');
      if (payload.client_id !== this.options.clientId) throw new InvalidTokenError('wrong client');
      const sub = subjectClaim.parse(payload.sub);
      const groups: unknown = payload['cognito:groups'];
      const groupNames = Array.isArray(groups) ? groups.filter((g): g is string => typeof g === 'string') : [];
      const roles = [...new Set(groupNames.filter((g): g is Role => roleSchema.safeParse(g).success))];
      // Exactly one "tenant:<id>" group, or the user is refused (403). Unknown groups are ignored.
      const tenant = tenantFromGroups(groupNames);
      if (!tenant.ok) throw new NoTenantError();
      return { sub, tenantId: tenant.tenantId, roles, issuedAt: payload.iat! };
    } catch (error) {
      if (error instanceof NoTenantError) throw error;
      // Operators need to know when the key set is the problem; callers never learn why they were refused.
      if (!(error instanceof InvalidTokenError) && !this.isTokenProblem(error)) {
        this.logger.warn({ event: 'token-key-set-unavailable', error }, 'Could not verify a token because the key set was unavailable');
      }
      throw new InvalidTokenError('Invalid token');
    }
  }

  /** True for errors that mean "this token is bad" rather than "we could not reach the key set". */
  private isTokenProblem(error: unknown): boolean {
    return (
      error instanceof joseErrors.JWTClaimValidationFailed ||
      error instanceof joseErrors.JWTExpired ||
      error instanceof joseErrors.JWSSignatureVerificationFailed ||
      error instanceof joseErrors.JWSInvalid ||
      error instanceof joseErrors.JWTInvalid ||
      error instanceof joseErrors.JOSEAlgNotAllowed ||
      error instanceof joseErrors.JWKSNoMatchingKey ||
      error instanceof z.ZodError
    );
  }
}
