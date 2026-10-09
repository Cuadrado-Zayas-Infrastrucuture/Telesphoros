import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { Principal } from '../auth/principal';
import { type Decision, TokenBucketLimiter } from './token-bucket';

export const RATE_LIMIT_CONFIG = Symbol('RATE_LIMIT_CONFIG');

/** How costly a route is. A request spends one token from the bucket of its class, per person. */
export type RateClass = 'read' | 'write' | 'expensive';

export interface RateLimitConfig {
  enabled: boolean;
  /** Requests per minute, per client address, counted BEFORE authentication. */
  ipPerMinute: number;
  /** Requests per minute, per person (tenant + individual), counted AFTER authentication. */
  perMinute: Record<RateClass, number>;
  /** Hard cap on remembered keys per limiter. */
  maxKeys: number;
  /** Milliseconds; only tests set it, to control time. */
  now?: () => number;
}

const SWEEP_EVERY_MS = 60_000;

/**
 * The limits in force in this process: one bucket per client address (before sign-in) and one per person and route class (after).
 * A person is a tenant AND an individual: the same individual id in two tenants is two people, and one person never limits another.
 */
@Injectable()
export class RateLimitService implements OnModuleDestroy {
  private readonly ip: TokenBucketLimiter;
  private readonly person: Record<RateClass, TokenBucketLimiter>;
  private readonly timer: NodeJS.Timeout | undefined;

  constructor(@Inject(RATE_LIMIT_CONFIG) private readonly config: RateLimitConfig) {
    const limiter = (perMinute: number) => new TokenBucketLimiter({ capacity: perMinute, refillPerSecond: perMinute / 60, maxKeys: config.maxKeys, now: config.now });
    this.ip = limiter(config.ipPerMinute);
    this.person = { read: limiter(config.perMinute.read), write: limiter(config.perMinute.write), expensive: limiter(config.perMinute.expensive) };
    if (config.enabled) {
      this.timer = setInterval(() => this.sweep(), SWEEP_EVERY_MS);
      this.timer.unref(); // housekeeping must never keep the process alive
    }
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  checkIp(address: string | undefined): Decision {
    return this.ip.take(address ?? 'unknown');
  }

  checkPerson(principal: Principal, rateClass: RateClass): Decision {
    // JSON, not a joined string: tenant "a|b" with person "c" must never collide with tenant "a" and person "b|c".
    return this.person[rateClass].take(JSON.stringify([principal.tenantId, principal.sub]));
  }

  sweep(): number {
    return this.ip.sweep() + this.person.read.sweep() + this.person.write.sweep() + this.person.expensive.sweep();
  }

  /** For tests: how many keys are remembered. */
  get remembered(): number {
    return this.ip.size + this.person.read.size + this.person.write.size + this.person.expensive.size;
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }
}
