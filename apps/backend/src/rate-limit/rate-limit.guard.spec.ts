import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IpRateLimitGuard, PersonRateLimitGuard } from './rate-limit.guard';
import { type RateLimitConfig, RateLimitService } from './rate-limit.service';

// The guards' own decisions without HTTP: what they do when limiting is switched off, and with no person.
const config = (enabled: boolean): RateLimitConfig => ({ enabled, ipPerMinute: 1, perMinute: { read: 1, write: 1, expensive: 1 }, maxKeys: 100 });
const context = (request: object): ExecutionContext =>
  ({ getHandler: () => () => undefined, getClass: () => class Stub {}, switchToHttp: () => ({ getRequest: () => request }) }) as unknown as ExecutionContext;
const signedIn = { ip: '203.0.113.5', method: 'GET', principal: { sub: 'p', tenantId: 't', roles: ['reader'] } };

describe('the rate limit guards when limiting is switched off', () => {
  it('let everything through, however low the limits are (control: the same traffic is refused when it is on)', () => {
    for (const enabled of [false, true]) {
      const limits = new RateLimitService(config(enabled));
      const ip = new IpRateLimitGuard(new Reflector(), limits);
      const person = new PersonRateLimitGuard(new Reflector(), limits);
      const outcome = (guard: { canActivate(c: ExecutionContext): boolean }) => {
        const results: Array<boolean | 'refused'> = [];
        for (let i = 0; i < 3; i++) {
          try {
            results.push(guard.canActivate(context(signedIn)));
          } catch {
            results.push('refused');
          }
        }
        return results;
      };
      if (enabled) {
        expect(outcome(ip)).toEqual([true, 'refused', 'refused']);
        expect(outcome(person)).toEqual([true, 'refused', 'refused']);
      } else {
        expect(outcome(ip)).toEqual([true, true, true]);
        expect(outcome(person)).toEqual([true, true, true]);
      }
      limits.onModuleDestroy();
    }
  });

  it('the person guard lets a request with no person through (only the address limit applies to it)', () => {
    const limits = new RateLimitService(config(true));
    const person = new PersonRateLimitGuard(new Reflector(), limits);
    for (let i = 0; i < 3; i++) expect(person.canActivate(context({ ip: '203.0.113.5', method: 'GET' }))).toBe(true);
    limits.onModuleDestroy();
  });
});
