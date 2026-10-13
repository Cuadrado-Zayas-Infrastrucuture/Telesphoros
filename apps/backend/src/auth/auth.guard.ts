import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AppException } from '../common/app-exception';
import { IS_PUBLIC_KEY } from './decorators';
import { NoTenantError, TokenVerifier } from './token-verifier';
import { SecurityAuditStore } from './security-audit';

/** Global guard: every route requires a valid bearer token unless it is marked @Public(). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: TokenVerifier,
    private readonly audit: SecurityAuditStore,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const routeKey = `${context.getClass().name}.${context.getHandler().name}`;
    const refused = () => this.audit.record({ type: 'api-auth', outcome: 'refused', tenantId: null, actorSub: null,
      routeKey, subjectId: null, requestId: String(req.id) });
    const [scheme, token, ...rest] = (req.headers.authorization ?? '').split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || !token || rest.length > 0) {
      await refused();
      throw AppException.unauthorized();
    }

    try {
      req.principal = await this.verifier.verify(token);
    } catch (error) {
      await refused();
      // A genuine token for a user without exactly one tenant: known, but not allowed in.
      if (error instanceof NoTenantError) throw AppException.forbidden();
      // intentional: never reveal why verification failed
      throw AppException.unauthorized();
    }
    await this.audit.record({ type: 'api-auth', outcome: 'accepted', tenantId: req.principal.tenantId,
      actorSub: req.principal.sub, routeKey, subjectId: null, requestId: String(req.id) });
    return true;
  }
}
