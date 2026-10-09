import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AppException } from '../common/app-exception';
import { RATE_CLASS_KEY, SKIP_RATE_LIMIT_KEY } from './rate-limit.decorators';
import { type RateClass, RateLimitService } from './rate-limit.service';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * BEFORE authentication: a generous per-address limit. It protects token verification (a flood of bad tokens costs signature checks and
 * key fetches) and counts every request from the address, signed in or not. Registered ahead of the authentication guard (auth.module.ts).
 */
@Injectable()
export class IpRateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limits: RateLimitService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.limits.enabled || skipped(this.reflector, context)) return true;
    const decision = this.limits.checkIp(context.switchToHttp().getRequest<Request>().ip);
    if (!decision.allowed) throw AppException.rateLimited(decision.retryAfterSeconds);
    return true;
  }
}

/**
 * AFTER authentication and roles: a per-person limit by route class. A request that is not signed in has no person, so only the address
 * limit applies to it. Registered after the roles guard, so a refused or unauthenticated request never spends a person's tokens.
 */
@Injectable()
export class PersonRateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly limits: RateLimitService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.limits.enabled || skipped(this.reflector, context)) return true;
    const request = context.switchToHttp().getRequest<Request>();
    if (!request.principal) return true;
    const declared = this.reflector.getAllAndOverride<RateClass | undefined>(RATE_CLASS_KEY, [context.getHandler(), context.getClass()]);
    const rateClass: RateClass = declared ?? (SAFE_METHODS.has(request.method) ? 'read' : 'write');
    const decision = this.limits.checkPerson(request.principal, rateClass);
    if (!decision.allowed) throw AppException.rateLimited(decision.retryAfterSeconds);
    return true;
  }
}

function skipped(reflector: Reflector, context: ExecutionContext): boolean {
  return reflector.getAllAndOverride<boolean | undefined>(SKIP_RATE_LIMIT_KEY, [context.getHandler(), context.getClass()]) === true;
}
