import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AppException } from '../common/app-exception';
import { IS_PUBLIC_KEY } from './decorators';
import { NoTenantError, TokenVerifier } from './token-verifier';

/** Global guard: every route requires a valid bearer token unless it is marked @Public(). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: TokenVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const [scheme, token, ...rest] = (req.headers.authorization ?? '').split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token || rest.length > 0) throw AppException.unauthorized();

    try {
      req.principal = await this.verifier.verify(token);
    } catch (error) {
      // A genuine token for a user without exactly one tenant: known, but not allowed in.
      if (error instanceof NoTenantError) throw AppException.forbidden();
      // intentional: never reveal why verification failed
      throw AppException.unauthorized();
    }
    return true;
  }
}
