import { Logger } from '@nestjs/common';

export interface CapabilityStats {
  /** Transactions that ran with a live capability set. */
  bound: number;
  /** Transactions that ran without one, for any reason below. */
  missing: number;
  byReason: Record<string, number>;
}

/** Say so on the first miss, then once per this many, so a deployment that never gets a capability does not log every request. */
const LOG_EVERY = 1000;

/**
 * The capability-less count of DATA-01 (FR-011, SC-005): in `guc` and `dual` mode a transaction without a capability still works, so the only way to
 * know it is safe to enforce is to count them. The unit is a TRANSACTION (a `withTenant` call), not a request; `bound + missing` is the denominator.
 * Counts and reason labels only: nothing here identifies a person, an organization or a token.
 */
export class CapabilityCounter {
  private readonly logger = new Logger('CapabilityCounter');
  private bound = 0;
  private missing = 0;
  private readonly byReason = new Map<string, number>();

  recordBound(): void {
    this.bound += 1;
  }

  recordMissing(reason: string): void {
    this.missing += 1;
    this.byReason.set(reason, (this.byReason.get(reason) ?? 0) + 1);
    if (this.missing === 1 || this.missing % LOG_EVERY === 0) {
      this.logger.warn(`Transactions without a tenant capability: ${this.missing} (latest reason: ${reason}), against ${this.bound} with one`);
    }
  }

  snapshot(): CapabilityStats {
    return { bound: this.bound, missing: this.missing, byReason: Object.fromEntries(this.byReason) };
  }
}
