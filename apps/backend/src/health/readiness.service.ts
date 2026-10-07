import { Inject, Injectable } from '@nestjs/common';
import type { ReadinessDto } from '@telesphoros/shared-types';
import { AppException } from '../common/app-exception';

export const READINESS_CHECKS = Symbol('READINESS_CHECKS');
export const CHECK_TIMEOUT_MS = 2000;

/** One dependency probe. `check()` resolves if the dependency is usable and rejects/throws if not. */
export interface ReadinessCheck {
  name: string;
  check(): Promise<void>;
}

@Injectable()
export class ReadinessService {
  constructor(@Inject(READINESS_CHECKS) private readonly checks: ReadinessCheck[]) {}

  /** Every probe is time-bounded, so a hung dependency makes /ready fail instead of hanging forever. */
  async run(): Promise<ReadinessDto> {
    const outcomes = await Promise.all(
      this.checks.map(async ({ name, check }) => {
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            check(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS);
            }),
          ]);
          return { name, up: true };
        } catch {
          // intentional: the reason is logged by the probe itself; the public body only names what is down
          return { name, up: false };
        } finally {
          clearTimeout(timer);
        }
      }),
    );

    const down = outcomes.filter((outcome) => !outcome.up);
    if (down.length > 0) {
      throw AppException.unavailable(
        'The service is not ready.',
        down.map(({ name }) => ({ field: name, message: 'unavailable' })),
      );
    }
    return { status: 'ready', checks: Object.fromEntries(outcomes.map(({ name }) => [name, 'up' as const])) };
  }
}
