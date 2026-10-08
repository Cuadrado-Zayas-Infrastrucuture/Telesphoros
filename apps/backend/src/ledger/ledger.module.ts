import { Global, Module } from '@nestjs/common';
import { ENV, type Env } from '../config/env';
import { FULL_BUDGET_MS, FULL_WALK_AT_OR_BELOW_EVENTS, LEDGER_VERIFIER, LEDGER_WATCH_CONFIG, LedgerMonitor, type LedgerWatchConfig, ON_DEMAND_BUDGET_MS } from './ledger-monitor';
import { LedgerStatus } from './ledger-status';
import { LedgerVerifier } from './verifier';

/**
 * The ledger watch: the shared status (the repository's append gate and the readiness check read it) and the monitor that keeps it current.
 * The admin route, `GET /ledger/verify`, belongs to the lab-report module with the other pipeline routes, so it is gated with them. This
 * module is always imported; the monitor does nothing unless a verifier login is configured (`LEDGER_VERIFIER_DATABASE_URL`).
 */
@Global()
@Module({
  providers: [
    LedgerStatus,
    {
      provide: LEDGER_WATCH_CONFIG,
      inject: [ENV],
      useFactory: (env: Env): LedgerWatchConfig => ({
        production: env.NODE_ENV === 'production',
        startupBudgetMs: env.LEDGER_STARTUP_BUDGET_MS,
        fullIntervalMs: env.LEDGER_FULL_VERIFY_INTERVAL_HOURS * 3_600_000,
        fullBudgetMs: FULL_BUDGET_MS,
        onDemandBudgetMs: ON_DEMAND_BUDGET_MS,
        fullWalkAtOrBelowEvents: FULL_WALK_AT_OR_BELOW_EVENTS,
      }),
    },
    // The verifier has its own pool and its own login; the monitor closes it when the application shuts down.
    {
      provide: LEDGER_VERIFIER,
      inject: [ENV],
      useFactory: (env: Env): LedgerVerifier | undefined => (env.LEDGER_VERIFIER_DATABASE_URL ? LedgerVerifier.connect(env.LEDGER_VERIFIER_DATABASE_URL, env.DATABASE_SSL) : undefined),
    },
    LedgerMonitor,
  ],
  exports: [LedgerStatus, LedgerMonitor],
})
export class LedgerModule {}
