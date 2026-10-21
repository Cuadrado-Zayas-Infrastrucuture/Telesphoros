import { Logger, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ENV, type Env } from '../config/env';
import { CapabilityIssuerPort, NullCapabilityIssuer } from '../issuer/capability-issuer.port';
import { HttpCapabilityIssuer } from '../issuer/issuer-http-client';
import { RequestCapabilities } from '../issuer/request-capabilities';
import { IpRateLimitGuard, PersonRateLimitGuard } from '../rate-limit/rate-limit.guard';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { InMemoryMembershipRepository, MembershipRepository } from '../storage/membership.repository';
import { AuthGuard } from './auth.guard';
import { CognitoTokenVerifier } from './cognito-token-verifier';
import { MembershipService } from './membership.service';
import { MirrorTokenVerifier } from './mirror-token-verifier';
import { RolesGuard } from './roles.guard';
import { HmacTokenVerifier, TokenVerifier } from './token-verifier';

/** loadEnv() guarantees the settings each branch needs, and refuses `hmac` in production. */
export function createVerifier(env: Env): TokenVerifier {
  if (env.AUTH_VERIFIER === 'cognito') {
    return new CognitoTokenVerifier({
      issuer: env.COGNITO_ISSUER ?? `https://cognito-idp.${env.COGNITO_REGION}.amazonaws.com/${env.COGNITO_USER_POOL_ID}`,
      clientId: env.COGNITO_APP_CLIENT_ID!,
      jwksUri: env.COGNITO_JWKS_URI,
    });
  }
  return new HmacTokenVerifier({ JWT_SECRET: env.JWT_SECRET!, JWT_ISSUER: env.JWT_ISSUER, JWT_AUDIENCE: env.JWT_AUDIENCE });
}

/**
 * The verifier the application uses. On the in-memory store (development) the membership mirrors the verified token so there is something to
 * check without a database; PostgreSQL, and therefore production (which requires it), always uses the real table and nothing is mirrored.
 */
export function createApplicationVerifier(env: Env, memberships: MembershipRepository): TokenVerifier {
  const verifier = createVerifier(env);
  if (env.STORAGE_DRIVER !== 'memory') return verifier;
  if (env.NODE_ENV === 'production' || !(memberships instanceof InMemoryMembershipRepository)) throw new Error('Token-mirrored membership is for the in-memory development store only');
  new Logger('Auth').warn('Development store: each verified token\'s roles are mirrored into membership, so there is no operator step. Never used with PostgreSQL or in production.');
  return new MirrorTokenVerifier(verifier, memberships);
}

/**
 * The port the guard asks for a capability. With ISSUER_URL (set by Terraform only when enable_issuer is on) it is the HTTP client for the session issuer; without
 * it, the null issuer: no capability is requested and behaviour is exactly what it was before the issuer existed. loadEnv() has already refused an unusable address.
 * What production does when enforcement is on and this is unset is a slice 5 decision (T031): the binding mode lives in the database, not here.
 */
export function createCapabilityIssuer(env: Env): CapabilityIssuerPort {
  return env.ISSUER_URL ? new HttpCapabilityIssuer({ baseUrl: env.ISSUER_URL }) : new NullCapabilityIssuer();
}

@Module({
  imports: [RateLimitModule],
  providers: [
    { provide: TokenVerifier, useFactory: createApplicationVerifier, inject: [ENV, MembershipRepository] },
    MembershipService,
    // No ISSUER_URL, no capability is requested: behaviour in `guc` mode is unchanged.
    { provide: CapabilityIssuerPort, useFactory: createCapabilityIssuer, inject: [ENV] },
    RequestCapabilities,
    // Order matters. The address limit comes FIRST (a flood of bad tokens must be stopped before token verification), then authenticate,
    // then check roles, then the per-person limit (so a request that is refused or not signed in never spends a person's tokens).
    { provide: APP_GUARD, useClass: IpRateLimitGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: PersonRateLimitGuard },
  ],
  exports: [TokenVerifier],
})
export class AuthModule {}
