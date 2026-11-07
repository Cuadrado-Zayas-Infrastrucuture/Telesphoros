import { Controller, Param, Post, Res } from '@nestjs/common';
import { type EvaluationDto, type IdParam, idParamSchema } from '@telesphoros/shared-types';
import type { Response } from 'express';
import { CurrentPrincipal, Roles } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RateLimitClass } from '../rate-limit/rate-limit.decorators';
import { EvaluationsService } from './evaluations.service';
import { RequiresSyntheticAssessment } from './pipeline-switch';

const CAN_ASSESS = ['clinician', 'reviewer'] as const;

/**
 * `POST /reports/:id/structured-assessment`: assesses the stored structured revision of a report against the synthetic knowledge (032 S3). Open only
 * while SYNTHETIC_ASSESSMENT is on, and never part of the pipeline. The request names nothing but the report: what is assessed is whatever the stored
 * revision, its independent reviews and the verified patient link say at the moment of the call.
 */
@Controller('reports')
@RequiresSyntheticAssessment()
export class StructuredAssessmentController {
  constructor(private readonly evaluations: EvaluationsService) {}

  /** 201 for a new assessment, 200 when the same assessment (same revision, reviews, knowledge and build) already exists. */
  @Post(':id/structured-assessment')
  @RateLimitClass('expensive')
  @Roles(...CAN_ASSESS)
  async create(
    @CurrentPrincipal() principal: Principal,
    @Param(new ZodValidationPipe(idParamSchema)) { id }: IdParam,
    @Res({ passthrough: true }) res: Response,
  ): Promise<EvaluationDto> {
    const { evaluation, created } = await this.evaluations.assessStructured(principal, id);
    res.status(created ? 201 : 200);
    return evaluation;
  }
}
