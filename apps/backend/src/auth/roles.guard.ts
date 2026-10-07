import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Role } from '@telesphoros/shared-types';
import type { Request } from 'express';
import { AppException } from '../common/app-exception';
import { ROLES_KEY } from './decorators';

/** Global guard, runs after AuthGuard: enforces @Roles() when a route declares it. */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const principal = context.switchToHttp().getRequest<Request>().principal;
    // No principal here means the route was @Public(): a public route must not also require roles.
    if (!principal || !required.some((role) => principal.roles.includes(role))) throw AppException.forbidden();
    return true;
  }
}
