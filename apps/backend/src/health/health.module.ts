import { Module } from '@nestjs/common';
import { Database } from '../db/database';
import { LedgerMonitor } from '../ledger/ledger-monitor';
import { LedgerStatus } from '../ledger/ledger-status';
import { databaseReachableCheck, migrationsAppliedCheck } from './database.readiness';
import { ledgerChainCheck } from './ledger.readiness';
import { HealthController } from './health.controller';
import { READINESS_CHECKS, ReadinessService } from './readiness.service';

@Module({
  controllers: [HealthController],
  providers: [
    {
      provide: READINESS_CHECKS,
      // The database exists only when STORAGE_DRIVER=postgres; with the in-memory store there is nothing to probe.
      // The ledger check appears only when the watch is configured (a verifier login), so a setup without one reports exactly what it did before.
      useFactory: (monitor: LedgerMonitor, status: LedgerStatus, db?: Database) =>
        db ? [databaseReachableCheck(db), migrationsAppliedCheck(db), ...(monitor.enabled ? [ledgerChainCheck(status)] : [])] : [],
      inject: [LedgerMonitor, LedgerStatus, { token: Database, optional: true }],
    },
    ReadinessService,
  ],
})
export class HealthModule {}
