import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AppException } from '../common/app-exception';
import { bindRequestAuthority } from './authority-context';
import { IS_PUBLIC_KEY } from './decorators';
import { MembershipService } from './membership.service';
import { NoTenantError, TokenVerifier } from './token-verifier';
import { SecurityAuditStore } from './security-audit';

/** Global guard: every route requires a valid bearer token AND a current membership unless it is marked @Public(). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: TokenVerifier,
    private readonly membership: MembershipService,
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

    let identity;
    try {
      identity = await this.verifier.verify(token);
    } catch (error) {
      await refused();
      // A genuine token for a user without exactly one tenant: known, but not allowed in.
      if (error instanceof NoTenantError) throw AppException.forbidden();
      // intentional: never reveal why verification failed
      throw AppException.unauthorized();
    }
    // The token was verified (this does not yet say the membership allows anything: that is the next step).
    await this.audit.record({ type: 'api-auth', outcome: 'accepted', tenantId: identity.tenantId, actorSub: identity.sub, routeKey, subjectId: null, requestId: String(req.id) });
    // The token proved who this is. What they may do now comes from the membership row, read fresh (a throw here is a refusal, never a guess).
    const { principal, version } = await this.membership.resolve(identity);
    req.principal = principal;
    bindRequestAuthority({ sub: principal.sub, version });
    return true;
  }
}
