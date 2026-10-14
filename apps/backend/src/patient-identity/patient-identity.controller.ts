import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, Res } from '@nestjs/common';
import {
  type IdentifierCreate,
  identifierCreateSchema,
  type IdentifierDto,
  type IdentifierParam,
  identifierParamSchema,
  type IdParam,
  idParamSchema,
  type PatientLinkDecisionCreate,
  type PatientLinkDecisionDto,
  patientLinkDecisionCreateSchema,
  type PatientLinkDto,
  type Paginated,
  type PaginationQuery,
  paginationQuerySchema,
  type QuarantineEntryDto,
} from '@telesphoros/shared-types';
import type { Response } from 'express';
import { CLINICAL_READ_ROLES } from '../auth/clinical-read';
import { CurrentPrincipal, Roles } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequiresPipeline } from '../lab-reports/pipeline-switch';
import { RateLimitClass } from '../rate-limit/rate-limit.decorators';
import { PatientIdentityService } from './patient-identity.service';
import { PatientLinkService } from './patient-link.service';

// Registering an identifier changes a patient's data: clinicians only (admin is administration only).
const CAN_REGISTER = ['clinician'] as const;
// Deciding whose report it is: a second person, clinician or reviewer. The service refuses the people who registered or uploaded the report.
const CAN_DECIDE = ['clinician', 'reviewer'] as const;

@Controller('patients/:id/identifiers')
export class PatientIdentifiersController {
  constructor(private readonly service: PatientIdentityService) {}

  @Post()
  @Roles(...CAN_REGISTER)
  add(
    @CurrentPrincipal() principal: Principal,
    @Param(new ZodValidationPipe(idParamSchema)) { id }: IdParam,
    @Body(new ZodValidationPipe(identifierCreateSchema)) body: IdentifierCreate,
  ): Promise<IdentifierDto> {
    return this.service.add(principal, id, body);
  }

  @Get()
  @Roles(...CLINICAL_READ_ROLES)
  async list(@CurrentPrincipal() principal: Principal, @Param(new ZodValidationPipe(idParamSchema)) { id }: IdParam): Promise<{ data: IdentifierDto[] }> {
    return { data: await this.service.list(principal, id) };
  }

  @Delete(':identifierId')
  @Roles(...CAN_REGISTER)
  @HttpCode(204)
  async withdraw(@CurrentPrincipal() principal: Principal, @Param(new ZodValidationPipe(identifierParamSchema)) { id, identifierId }: IdentifierParam): Promise<void> {
    await this.service.withdraw(principal, id, identifierId);
  }
}

@Controller('reports/:id/patient-link')
@RequiresPipeline()
export class ReportPatientLinkController {
  constructor(private readonly service: PatientLinkService) {}

  @Get()
  @Roles(...CLINICAL_READ_ROLES)
  get(@CurrentPrincipal() principal: Principal, @Param(new ZodValidationPipe(idParamSchema)) { id }: IdParam): Promise<PatientLinkDto> {
    return this.service.get(principal, id);
  }

  /** 201 for a new decision, 200 when the newest decision for this file already says the same thing. */
  @Post('decisions')
  @RateLimitClass('expensive')
  @Roles(...CAN_DECIDE)
  async decide(
    @CurrentPrincipal() principal: Principal,
    @Param(new ZodValidationPipe(idParamSchema)) { id }: IdParam,
    @Body(new ZodValidationPipe(patientLinkDecisionCreateSchema)) body: PatientLinkDecisionCreate,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PatientLinkDecisionDto> {
    const { decision, created } = await this.service.decide(principal, id, body);
    res.status(created ? 201 : 200);
    return decision;
  }
}

/** The reviewer's work list of quarantined reports (M2.1c-1). A pipeline route: the evaluations it is about exist only with the pipeline. */
@Controller('patient-link/quarantine')
@RequiresPipeline()
export class PatientLinkQuarantineController {
  constructor(private readonly service: PatientLinkService) {}

  @Get()
  @Roles('reviewer')
  list(@CurrentPrincipal() principal: Principal, @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery): Promise<Paginated<QuarantineEntryDto>> {
    return this.service.quarantine(principal, query);
  }
}
