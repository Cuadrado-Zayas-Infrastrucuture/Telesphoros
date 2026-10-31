import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  type IdParam,
  idParamSchema,
  type PatientDemographicsDto,
  type PatientDemographicsInput,
  patientDemographicsInputSchema,
  type PatientDemographicsQuery,
  patientDemographicsQuerySchema,
} from '@telesphoros/shared-types';
import { CLINICAL_READ_ROLES } from '../auth/clinical-read';
import { CurrentPrincipal, Roles } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { PatientDemographicsService } from './patient-demographics.service';

// Same rule as creating a patient: changing data needs the clinician role. Reading the identity needs a clinical role; an administrator, who manages people
// and reads no clinical data, and a member with no role get a 403 and never see an identity field.
const CAN_WRITE = ['clinician'] as const;

@Controller('patients/:id/demographics')
export class PatientDemographicsController {
  constructor(private readonly service: PatientDemographicsService) {}

  @Get()
  @Roles(...CLINICAL_READ_ROLES)
  get(
    @CurrentPrincipal() principal: Principal,
    @Param(new ZodValidationPipe(idParamSchema)) { id }: IdParam,
    @Query(new ZodValidationPipe(patientDemographicsQuerySchema)) { version }: PatientDemographicsQuery,
  ): Promise<PatientDemographicsDto> {
    return this.service.read(principal, id, version);
  }

  @Post()
  @Roles(...CAN_WRITE)
  @HttpCode(201)
  record(
    @CurrentPrincipal() principal: Principal,
    @Param(new ZodValidationPipe(idParamSchema)) { id }: IdParam,
    @Body(new ZodValidationPipe(patientDemographicsInputSchema)) body: PatientDemographicsInput,
  ): Promise<PatientDemographicsDto> {
    return this.service.record(principal, id, body);
  }
}
