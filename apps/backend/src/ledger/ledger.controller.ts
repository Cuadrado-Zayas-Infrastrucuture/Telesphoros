import { Controller, Get, Query } from '@nestjs/common';
import { type LedgerVerifyQuery, ledgerVerifyQuerySchema, type LedgerVerifyResult } from '@telesphoros/shared-types';
import { CurrentPrincipal, Roles } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequiresPipeline } from '../lab-reports/pipeline-switch';
import { LedgerMonitor } from './ledger-monitor';

/**
 * An admin's check of the record log of THEIR OWN tenant, now. The default walks from the latest checkpoint; `full=true` walks the whole
 * chain. Success records a checkpoint. A failure stops this instance from writing records until it is restarted after an investigation.
 * The answer names kinds of failure and sequence numbers, never a value from a record.
 */
@Controller('ledger')
@RequiresPipeline()
export class LedgerController {
  constructor(private readonly monitor: LedgerMonitor) {}

  @Get('verify')
  @Roles('admin')
  async verify(@CurrentPrincipal() principal: Principal, @Query(new ZodValidationPipe(ledgerVerifyQuerySchema)) query: LedgerVerifyQuery): Promise<LedgerVerifyResult> {
    const result = await this.monitor.verifyNow(principal.tenantId, query.full === 'true');
    return {
      status: result.status, mode: result.mode, headSeq: result.headSeq, headHash: result.headHash, eventsChecked: result.eventsChecked,
      failures: result.failures.map(({ kind, seq }) => ({ kind, seq })), checkpointId: result.checkpointId,
    };
  }
}
