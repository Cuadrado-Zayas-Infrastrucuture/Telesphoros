import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { READINESS_CHECKS, ReadinessService } from './readiness.service';

@Module({
  controllers: [HealthController],
  // No dependencies to probe yet. Phase 3 adds a database check here.
  providers: [{ provide: READINESS_CHECKS, useValue: [] }, ReadinessService],
})
export class HealthModule {}
