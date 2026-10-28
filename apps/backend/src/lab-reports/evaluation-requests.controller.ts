import { Body, Controller, Get, Inject, Param, Post, Res } from '@nestjs/common';
import { type EvaluationRequestBody, evaluationRequestBodySchema, type EvaluationRequestDto, type IdParam, idParamSchema } from '@telesphoros/shared-types';
import type { Response } from 'express';
import { CLINICAL_READ_ROLES } from '../auth/clinical-read';
import { CurrentPrincipal, Roles } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { AppException } from '../common/app-exception';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RateLimitClass } from '../rate-limit/rate-limit.decorators';
import type { EvaluationRequestsService } from './evaluation-requests.service';
import { EVALUATION_REQUESTS_SERVICE, RequiresEvaluationRequests } from './evaluation-requests-switch';

const CAN_EVALUATE = ['clinician', 'reviewer'] as const;

/**
 * H4: queue an evaluation (H1's admission) and read its status. Behind the pipeline's switch and EVALUATION_REQUESTS, both refused in production. The
 * worker that answers a request (H3) is a separate process; nothing here starts, schedules or registers it. A state is operational, never a clinical result.
 */
@Controller()
@RequiresEvaluationRequests()
export class EvaluationRequestsController {
  constructor(@Inject(EVALUATION_REQUESTS_SERVICE) private readonly service: EvaluationRequestsService | undefined) {}

  /** The gate already answered 503 while the switch is off; this is the second line, should the two ever disagree. */
  private requests(): EvaluationRequestsService {
    if (!this.service) throw AppException.evaluationRequestsDisabled();
    return this.service;
  }

  /** 202 for a newly queued request, 200 when the same person sent the same `requestId` for the same evaluation before. */
  @Post('reports/:id/evaluation-requests')
  @RateLimitClass('expensive')
  @Roles(...CAN_EVALUATE)
  async admit(
    @CurrentPrincipal() principal: Principal,
    @Param(new ZodValidationPipe(idParamSchema)) { id }: IdParam,
    @Body(new ZodValidationPipe(evaluationRequestBodySchema)) body: EvaluationRequestBody,
    @Res({ passthrough: true }) res: Response,
  ): Promise<EvaluationRequestDto> {
    const { request, created } = await this.requests().admit(principal, { ...body, reportId: id });
    res.status(created ? 202 : 200);
    return request;
  }

  @Get('evaluation-requests/:id')
  @Roles(...CLINICAL_READ_ROLES)
  get(@CurrentPrincipal() principal: Principal, @Param(new ZodValidationPipe(idParamSchema)) { id }: IdParam): Promise<EvaluationRequestDto> {
    return this.requests().get(principal, id);
  }
}
