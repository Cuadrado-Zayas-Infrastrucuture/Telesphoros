import { type DynamicModule, Global, Module, type Provider } from '@nestjs/common';
import { Database } from '../db/database';
import type { Env } from '../config/env';
import { LedgerRecordsRepository } from './ledger-records.repository';
import { InMemoryMembershipRepository, MembershipRepository } from './membership.repository';
import { PostgresMembershipRepository } from './postgres/membership.repository';
import { PostgresLedgerRecordsRepository } from './postgres/ledger-records.repository';
import { InMemoryPatientsRepository, PatientsRepository } from './patients.repository';
import { PostgresPatientsRepository } from './postgres/patients.repository';
import { PostgresRecommendationsRepository } from './postgres/recommendations.repository';
import { PostgresReportsRepository } from './postgres/reports.repository';
import { InMemoryRecommendationsRepository, RecommendationsRepository } from './recommendations.repository';
import { InMemoryReportsRepository, ReportsRepository } from './reports.repository';

/**
 * The one place that decides which persistence backs the repositories. Controllers and services
 * only ever see the abstract repository classes, so swapping the store changes nothing above it.
 */
@Global()
@Module({})
export class StorageModule {
  static register(env: Env): DynamicModule {
    const repositories = [PatientsRepository, ReportsRepository, RecommendationsRepository, MembershipRepository];

    if (env.STORAGE_DRIVER === 'postgres') {
      const providers: Provider[] = [
        // useFactory, so the pool is created (and later closed) by Nest's lifecycle.
        { provide: Database, useFactory: () => new Database({ url: env.DATABASE_URL!, ssl: env.DATABASE_SSL }) },
        { provide: PatientsRepository, useClass: PostgresPatientsRepository },
        { provide: ReportsRepository, useClass: PostgresReportsRepository },
        { provide: RecommendationsRepository, useClass: PostgresRecommendationsRepository },
        { provide: MembershipRepository, useClass: PostgresMembershipRepository },
        // The ledger's guarantees are database guarantees: there is deliberately no in-memory version.
        { provide: LedgerRecordsRepository, useClass: PostgresLedgerRecordsRepository },
      ];
      return { module: StorageModule, providers, exports: [Database, ...repositories, LedgerRecordsRepository] };
    }

    return {
      module: StorageModule,
      providers: [
        { provide: PatientsRepository, useClass: InMemoryPatientsRepository },
        { provide: ReportsRepository, useClass: InMemoryReportsRepository },
        { provide: RecommendationsRepository, useClass: InMemoryRecommendationsRepository },
        { provide: MembershipRepository, useClass: InMemoryMembershipRepository },
      ],
      exports: repositories,
    };
  }
}
