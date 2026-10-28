import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@telesphoros/shared-types';
import type { Request } from 'express';
import { AppException } from '../common/app-exception';
import { ROLES_KEY } from './decorators';
import { SecurityAuditStore } from './security-audit';
import { accessEvent, WRITE_METHODS, writeEvent } from './security-audit.interceptor';

/** Global guard, runs after AuthGuard: enforces @Roles() when a route declares it. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: SecurityAuditStore,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [context.getHandler(), context.getClass()]);
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const principal = req.principal;
    // No principal here means the route was @Public(): a public route must not also require roles.
    if (!principal || !required.some((role) => principal.roles.includes(role))) {
      // A refusal is evidence of a probe, so a read and a write each leave a row (the interceptor that records an accepted write never runs for a refused one).
      if (principal && req.method === 'GET') await this.audit.record(accessEvent(context, req, 'refused'));
      else if (principal && WRITE_METHODS.has(req.method)) await this.audit.record(writeEvent(context, req, 'refused'));
      throw AppException.forbidden();
    }
    return true;
  }
}
