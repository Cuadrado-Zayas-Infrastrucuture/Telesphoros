import { Body, Controller, Get, Param, Post, Res } from '@nestjs/common';
import {
  type IdParam,
  idParamSchema,
  type ResultAcknowledgementCreate,
  resultAcknowledgementCreateSchema,
  type ResultAcknowledgementDto,
  type ResultAcknowledgementsDto,
} from '@telesphoros/shared-types';
import type { Response } from 'express';
import { CLINICAL_READ_ROLES } from '../auth/clinical-read';
import { CurrentPrincipal, Roles } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequiresPipeline } from './pipeline-switch';
import { ResultAcknowledgementsService } from './result-acknowledgements.service';

/** Only a clinician acknowledges a result (A6); the database checks the live membership again. Review on someone else's behalf is not supported. */
const CAN_ACKNOWLEDGE = ['clinician'] as const;

/** Spec 019 D02a. A sibling of the spec 006 decision history (A1), which is not changed. */
@Controller('evaluation-results')
@RequiresPipeline()
export class ResultAcknowledgementsController {
  constructor(private readonly acknowledgements: ResultAcknowledgementsService) {}

  /** 201 for a new acknowledgement, 200 for a replay of the same request (same `requestId`, same fields). */
  @Post(':id/acknowledgements')
  @Roles(...CAN_ACKNOWLEDGE)
  async record(
    @CurrentPrincipal() principal: Principal,
    @Param(new ZodValidationPipe(idParamSchema)) { id }: IdParam,
    @Body(new ZodValidationPipe(resultAcknowledgementCreateSchema)) body: ResultAcknowledgementCreate,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ResultAcknowledgementDto> {
    const { entry, created } = await this.acknowledgements.record(principal, id.toLowerCase(), body);
    res.status(created ? 201 : 200);
    return entry;
  }

  @Get(':id/acknowledgements')
  @Roles(...CLINICAL_READ_ROLES)
  list(@CurrentPrincipal() principal: Principal, @Param(new ZodValidationPipe(idParamSchema)) { id }: IdParam): Promise<ResultAcknowledgementsDto> {
    return this.acknowledgements.list(principal, id.toLowerCase());
  }
}
