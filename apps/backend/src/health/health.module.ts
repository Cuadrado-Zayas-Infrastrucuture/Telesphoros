import { Module } from '@nestjs/common';
import { Database } from '../db/database';
import { databaseReachableCheck, migrationsAppliedCheck } from './database.readiness';
import { HealthController } from './health.controller';
import { READINESS_CHECKS, ReadinessService } from './readiness.service';

@Module({
  controllers: [HealthController],
  providers: [
    {
      provide: READINESS_CHECKS,
      // The database exists only when STORAGE_DRIVER=postgres; with the in-memory store there is nothing to probe.
      useFactory: (db?: Database) => (db ? [databaseReachableCheck(db), migrationsAppliedCheck(db)] : []),
      inject: [{ token: Database, optional: true }],
    },
    ReadinessService,
  ],
})
export class HealthModule {}
