import { Body, Controller, Get, Param, Post, Res } from '@nestjs/common';
import {
  type ClinicianDecisionCreate,
  clinicianDecisionCreateSchema,
  type ClinicianDecisionDto,
  type ClinicianDecisionHistoryDto,
  type IdParam,
  idParamSchema,
} from '@telesphoros/shared-types';
import type { Response } from 'express';
import { CLINICAL_READ_ROLES } from '../auth/clinical-read';
import { CurrentPrincipal, Roles } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { ClinicianDecisionsService } from './clinician-decisions.service';
import { RequiresPipeline } from './pipeline-switch';

/** Only a clinician records a decision (D2); the database checks the live membership again. Entry on someone else's behalf is not supported. */
const CAN_DECIDE = ['clinician'] as const;

@Controller('evaluation-results')
@RequiresPipeline()
export class ClinicianDecisionsController {
  constructor(private readonly decisions: ClinicianDecisionsService) {}

  /** 201 for a new entry, 200 for a replay of the same request (same `requestId`, same fields). */
  @Post(':id/clinician-decisions')
  @Roles(...CAN_DECIDE)
  async record(
    @CurrentPrincipal() principal: Principal,
    @Param(new ZodValidationPipe(idParamSchema)) { id }: IdParam,
    @Body(new ZodValidationPipe(clinicianDecisionCreateSchema)) body: ClinicianDecisionCreate,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ClinicianDecisionDto> {
    const { entry, created } = await this.decisions.record(principal, id.toLowerCase(), body);
    res.status(created ? 201 : 200);
    return entry;
  }

  @Get(':id/clinician-decisions')
  @Roles(...CLINICAL_READ_ROLES)
  history(@CurrentPrincipal() principal: Principal, @Param(new ZodValidationPipe(idParamSchema)) { id }: IdParam): Promise<ClinicianDecisionHistoryDto> {
    return this.decisions.history(principal, id.toLowerCase());
  }
}
