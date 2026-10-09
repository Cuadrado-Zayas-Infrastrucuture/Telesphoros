import { Controller, Get } from '@nestjs/common';
import type { HealthDto, ReadinessDto } from '@telesphoros/shared-types';
import { Public } from '../auth/decorators';
import { SkipRateLimit } from '../rate-limit/rate-limit.decorators';
import { ReadinessService } from './readiness.service';

/**
 * - GET /api/v1/health : LIVENESS. "The process is up." Never touches dependencies, so a database
 *   outage cannot make an orchestrator kill and restart a healthy process.
 * - GET /api/v1/ready  : READINESS. "Safe to send traffic." Runs dependency checks (the database
 *   joins in Phase 3) and returns 503 while any is down, so a load balancer stops routing here.
 * Both are public and return no internal detail.
 */
@Controller()
@SkipRateLimit() // probes are called on a schedule by the load balancer
export class HealthController {
  constructor(private readonly readiness: ReadinessService) {}

  @Public()
  @Get('health')
  health(): HealthDto {
    return { status: 'ok' };
  }

  @Public()
  @Get('ready')
  ready(): Promise<ReadinessDto> {
    return this.readiness.run();
  }
}
