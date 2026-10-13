import { type DynamicModule, Global, Module, type Provider } from '@nestjs/common';
import { Database } from '../db/database';
import { InMemorySecurityAuditStore, PostgresSecurityAuditStore, SecurityAuditStore } from '../auth/security-audit';
import type { Env } from '../config/env';
import { LedgerRecordsRepository } from './ledger-records.repository';
import { InMemorySecurityEvents, PostgresSecurityEvents, SecurityEvents } from '../security-events/security-events';
import { MemberAdminRepository } from './member-admin.repository';
import { PostgresMemberAdminRepository } from './postgres/member-admin.repository';
import { InMemoryMembershipRepository, MembershipRepository } from './membership.repository';
import { PostgresMembershipRepository } from './postgres/membership.repository';
import { PostgresLedgerRecordsRepository } from './postgres/ledger-records.repository';
import { InMemoryPatientsRepository, PatientsRepository } from './patients.repository';
import { PostgresPatientIdentifiersRepository } from './postgres/patient-identifiers.repository';
import { PostgresPatientsRepository } from './postgres/patients.repository';
import { InMemoryPatientIdentifiersRepository, PatientIdentifiersRepository } from './patient-identifiers.repository';
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
    const repositories = [PatientsRepository, PatientIdentifiersRepository, ReportsRepository, RecommendationsRepository, MembershipRepository, MemberAdminRepository, SecurityEvents];

    if (env.STORAGE_DRIVER === 'postgres') {
      const providers: Provider[] = [
        // useFactory, so the pool is created (and later closed) by Nest's lifecycle.
        { provide: Database, useFactory: () => new Database({ url: env.DATABASE_URL!, ssl: env.DATABASE_SSL }) },
        { provide: SecurityAuditStore, useClass: PostgresSecurityAuditStore },
        { provide: PatientsRepository, useClass: PostgresPatientsRepository },
        { provide: PatientIdentifiersRepository, useClass: PostgresPatientIdentifiersRepository },
        { provide: ReportsRepository, useClass: PostgresReportsRepository },
        { provide: RecommendationsRepository, useClass: PostgresRecommendationsRepository },
        { provide: MembershipRepository, useClass: PostgresMembershipRepository },
        { provide: MemberAdminRepository, useClass: PostgresMemberAdminRepository },
        { provide: SecurityEvents, useClass: PostgresSecurityEvents },
        // The ledger's guarantees are database guarantees: there is deliberately no in-memory version.
        { provide: LedgerRecordsRepository, useClass: PostgresLedgerRecordsRepository },
      ];
      return { module: StorageModule, providers, exports: [Database, SecurityAuditStore, ...repositories, LedgerRecordsRepository] };
    }

    return {
      module: StorageModule,
      providers: [
        { provide: SecurityAuditStore, useClass: InMemorySecurityAuditStore },
        { provide: PatientsRepository, useClass: InMemoryPatientsRepository },
        { provide: PatientIdentifiersRepository, useClass: InMemoryPatientIdentifiersRepository },
        { provide: ReportsRepository, useClass: InMemoryReportsRepository },
        { provide: RecommendationsRepository, useClass: InMemoryRecommendationsRepository },
        { provide: MembershipRepository, useClass: InMemoryMembershipRepository },
        { provide: MemberAdminRepository, useExisting: MembershipRepository },
        { provide: SecurityEvents, useClass: InMemorySecurityEvents },
      ],
      exports: [SecurityAuditStore, ...repositories],
    };
  }
}
