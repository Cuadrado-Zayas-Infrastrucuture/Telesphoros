import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { type ResultRenderBatch, resultRenderBatchSchema, type ResultRenderBatchResult } from '@telesphoros/shared-types';
import { CLINICAL_READ_ROLES } from '../auth/clinical-read';
import { CurrentPrincipal, Roles } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequiresPipeline } from './pipeline-switch';
import { ResultRendersService } from './result-renders.service';

/**
 * Spec 019 D02b: the browser's render events (FR-06: any clinical reader, the database re-checking the live membership). All or nothing: a batch naming
 * a result outside the caller's organization is 404 and stores nothing. 200 with the counts, for a new batch and a retried one alike.
 */
@Controller('result-renders')
@RequiresPipeline()
export class ResultRendersController {
  constructor(private readonly renders: ResultRendersService) {}

  @Post()
  @HttpCode(200)
  @Roles(...CLINICAL_READ_ROLES)
  record(@CurrentPrincipal() principal: Principal, @Body(new ZodValidationPipe(resultRenderBatchSchema)) body: ResultRenderBatch): Promise<ResultRenderBatchResult> {
    return this.renders.record(principal, body);
  }
}
