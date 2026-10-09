import type { Principal } from '../auth/principal';
import { type RateLimitConfig, RateLimitService } from './rate-limit.service';

const person = (tenantId: string, sub: string): Principal => ({ tenantId, sub, roles: ['reader'] });
function service(over: Partial<RateLimitConfig> = {}) {
  const clock = { t: 5_000_000 };
  const limits = new RateLimitService({ enabled: false, ipPerMinute: 60, perMinute: { read: 60, write: 6, expensive: 2 }, maxKeys: 100, now: () => clock.t, ...over });
  return { limits, clock };
}

describe('RateLimitService keys and classes', () => {
  it('limits a person per route class, so spending the expensive bucket does not touch reads or writes', () => {
    const { limits } = service();
    const p = person('t', 'p');
    expect(limits.checkPerson(p, 'expensive').allowed).toBe(true);
    expect(limits.checkPerson(p, 'expensive').allowed).toBe(true);
    expect(limits.checkPerson(p, 'expensive').allowed).toBe(false);
    expect(limits.checkPerson(p, 'read').allowed).toBe(true);
    expect(limits.checkPerson(p, 'write').allowed).toBe(true);
  });

  it('counts a person as tenant AND individual: the same individual id in two tenants is two people, and two people in one tenant do not share', () => {
    const { limits } = service();
    for (let i = 0; i < 2; i++) limits.checkPerson(person('tenant-1', 'p'), 'expensive');
    expect(limits.checkPerson(person('tenant-1', 'p'), 'expensive').allowed).toBe(false);
    expect(limits.checkPerson(person('tenant-2', 'p'), 'expensive').allowed).toBe(true);
    expect(limits.checkPerson(person('tenant-1', 'q'), 'expensive').allowed).toBe(true);
  });

  it('cannot be fooled by separators: tenant "a|b" + person "c" is not tenant "a" + person "b|c"', () => {
    const { limits } = service();
    limits.checkPerson(person('a|b', 'c'), 'expensive');
    limits.checkPerson(person('a|b', 'c'), 'expensive');
    expect(limits.checkPerson(person('a|b', 'c'), 'expensive').allowed).toBe(false);
    expect(limits.checkPerson(person('a', 'b|c'), 'expensive').allowed).toBe(true);
    limits.checkPerson(person('a:b', 'c'), 'expensive');
    limits.checkPerson(person('a:b', 'c'), 'expensive');
    expect(limits.checkPerson(person('a', 'b:c'), 'expensive').allowed).toBe(true);
  });

  it('keeps the address limit apart from every person limit', () => {
    const { limits } = service({ ipPerMinute: 1 });
    expect(limits.checkIp('203.0.113.9').allowed).toBe(true);
    expect(limits.checkIp('203.0.113.9').allowed).toBe(false);
    expect(limits.checkPerson(person('t', 'p'), 'read').allowed).toBe(true);
    expect(limits.checkIp('203.0.113.10').allowed).toBe(true);
  });

  it('puts a request with no address into one shared bucket rather than letting it through', () => {
    const { limits } = service({ ipPerMinute: 1 });
    expect(limits.checkIp(undefined).allowed).toBe(true);
    expect(limits.checkIp(undefined).allowed).toBe(false);
  });

  it('bounds its memory and sweeps what has fully refilled', () => {
    const { limits, clock } = service({ maxKeys: 5 });
    for (let i = 0; i < 50; i++) limits.checkIp(`198.51.100.${i}`);
    expect(limits.remembered).toBeLessThanOrEqual(5);
    clock.t += 120_000;
    limits.sweep();
    expect(limits.remembered).toBe(0);
  });

  it('starts no timer when disabled, and an enabled one never keeps the process alive and stops on shutdown', () => {
    jest.useFakeTimers();
    try {
      const off = service({ enabled: false }).limits;
      expect(jest.getTimerCount()).toBe(0);
      off.onModuleDestroy();
      const on = service({ enabled: true }).limits;
      expect(jest.getTimerCount()).toBe(1);
      on.onModuleDestroy();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('the sweep timer never keeps the process alive', () => {
    const { limits } = service({ enabled: true });
    const timer = (limits as unknown as { timer: NodeJS.Timeout }).timer;
    expect(timer.hasRef()).toBe(false);
    limits.onModuleDestroy();
  });
});
