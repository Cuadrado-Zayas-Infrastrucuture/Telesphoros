import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import {
  type EvaluationCreate,
  evaluationCreateSchema,
  type EvaluationDto,
  type EvaluationListQuery,
  evaluationListQuerySchema,
  type EvaluationSummaryDto,
  type Paginated,
  type IdParam,
  idParamSchema,
} from '@telesphoros/shared-types';
import type { Response } from 'express';
import { CLINICAL_READ_ROLES } from '../auth/clinical-read';
import { CurrentPrincipal, Roles } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { EvaluationsService } from './evaluations.service';
import { RequiresPipeline } from './pipeline-switch';
import { RateLimitClass } from '../rate-limit/rate-limit.decorators';

const CAN_EVALUATE = ['clinician', 'reviewer'] as const;

/** `POST /reports/:id/evaluations`: the report-side route of the pipeline's last step. */
@Controller('reports')
@RequiresPipeline()
export class ReportEvaluationController {
  constructor(private readonly evaluations: EvaluationsService) {}

  /** 201 for a new evaluation, 200 when the same evaluation (same capture, decision, knowledge and build) already exists. */
  @Post(':id/evaluations')
  @RateLimitClass('expensive')
  @Roles(...CAN_EVALUATE)
  async create(
    @CurrentPrincipal() principal: Principal,
    @Param(new ZodValidationPipe(idParamSchema)) { id }: IdParam,
    @Body(new ZodValidationPipe(evaluationCreateSchema)) body: EvaluationCreate,
    @Res({ passthrough: true }) res: Response,
  ): Promise<EvaluationDto> {
    const { evaluation, created } = await this.evaluations.create(principal, id, body);
    res.status(created ? 201 : 200);
    return evaluation;
  }
}

@Controller('evaluations')
@RequiresPipeline()
export class EvaluationsController {
  constructor(private readonly evaluations: EvaluationsService) {}

  @Get()
  @Roles(...CLINICAL_READ_ROLES)
  list(@CurrentPrincipal() principal: Principal, @Query(new ZodValidationPipe(evaluationListQuerySchema)) query: EvaluationListQuery): Promise<Paginated<EvaluationSummaryDto>> {
    return this.evaluations.list(principal, query);
  }

  @Get(':id')
  @Roles(...CLINICAL_READ_ROLES)
  get(@CurrentPrincipal() principal: Principal, @Param(new ZodValidationPipe(idParamSchema)) { id }: IdParam): Promise<EvaluationDto> {
    return this.evaluations.get(principal, id);
  }
}
