import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ENV, type Env } from '../config/env';
import { AuthGuard } from './auth.guard';
import { RolesGuard } from './roles.guard';
import { HmacTokenVerifier, TokenVerifier } from './token-verifier';

@Module({
  providers: [
    { provide: TokenVerifier, useFactory: (env: Env) => new HmacTokenVerifier(env), inject: [ENV] },
    // Order matters: authenticate first, then check roles.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  exports: [TokenVerifier],
})
export class AuthModule {}
