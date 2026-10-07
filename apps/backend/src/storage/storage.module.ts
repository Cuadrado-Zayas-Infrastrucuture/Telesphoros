import { Global, Module } from '@nestjs/common';
import { InMemoryPatientsRepository, PatientsRepository } from './patients.repository';
import { InMemoryRecommendationsRepository, RecommendationsRepository } from './recommendations.repository';
import { InMemoryReportsRepository, ReportsRepository } from './reports.repository';

/** The one place that decides which persistence backs the repositories (Phase 3: the database). */
@Global()
@Module({
  providers: [
    { provide: PatientsRepository, useClass: InMemoryPatientsRepository },
    { provide: ReportsRepository, useClass: InMemoryReportsRepository },
    { provide: RecommendationsRepository, useClass: InMemoryRecommendationsRepository },
  ],
  exports: [PatientsRepository, ReportsRepository, RecommendationsRepository],
})
export class StorageModule {}
