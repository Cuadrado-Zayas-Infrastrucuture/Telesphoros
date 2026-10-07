import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ENV, type Env } from '../config/env';
import { AuthGuard } from './auth.guard';
import { CognitoTokenVerifier } from './cognito-token-verifier';
import { RolesGuard } from './roles.guard';
import { HmacTokenVerifier, TokenVerifier } from './token-verifier';

/** loadEnv() guarantees the settings each branch needs, and refuses `hmac` in production. */
function createVerifier(env: Env): TokenVerifier {
  if (env.AUTH_VERIFIER === 'cognito') {
    return new CognitoTokenVerifier({
      issuer: env.COGNITO_ISSUER ?? `https://cognito-idp.${env.COGNITO_REGION}.amazonaws.com/${env.COGNITO_USER_POOL_ID}`,
      clientId: env.COGNITO_APP_CLIENT_ID!,
      jwksUri: env.COGNITO_JWKS_URI,
    });
  }
  return new HmacTokenVerifier({ JWT_SECRET: env.JWT_SECRET!, JWT_ISSUER: env.JWT_ISSUER, JWT_AUDIENCE: env.JWT_AUDIENCE });
}

@Module({
  providers: [
    { provide: TokenVerifier, useFactory: createVerifier, inject: [ENV] },
    // Order matters: authenticate first, then check roles.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [TokenVerifier],
})
export class AuthModule {}
