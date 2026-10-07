import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Role } from '@telesphoros/shared-types';
import type { Request } from 'express';
import type { Principal } from './principal';

export const IS_PUBLIC_KEY = 'auth:isPublic';
export const ROLES_KEY = 'auth:roles';

/** Opt a route OUT of authentication. Everything is protected by default; use this sparingly. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** Require the caller to hold at least one of these roles (checked after authentication). */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

/** The authenticated caller. Only valid on routes that are not @Public(). */
export const CurrentPrincipal = createParamDecorator((_data: unknown, ctx: ExecutionContext): Principal => {
  const principal = ctx.switchToHttp().getRequest<Request>().principal;
  if (!principal) throw new Error('CurrentPrincipal used on a route without authentication');
  return principal;
});
