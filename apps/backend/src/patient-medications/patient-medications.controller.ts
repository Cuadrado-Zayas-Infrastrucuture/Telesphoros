import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  type IdParam,
  idParamSchema,
  type PatientMedicationInput,
  patientMedicationInputSchema,
  type PatientMedicationsQuery,
  patientMedicationsQuerySchema,
} from '@telesphoros/shared-types';
import { CLINICAL_READ_ROLES } from '../auth/clinical-read';
import { CurrentPrincipal, Roles } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { PatientMedicationsService } from './patient-medications.service';
@Controller('patients/:id/medications')
export class PatientMedicationsController {
  constructor(private readonly service: PatientMedicationsService) {}
  @Get()
  @Roles(...CLINICAL_READ_ROLES)
  get(
    @CurrentPrincipal() principal: Principal,
    @Param(new ZodValidationPipe(idParamSchema)) { id }: IdParam,
    @Query(new ZodValidationPipe(patientMedicationsQuerySchema)) query: PatientMedicationsQuery,
  ) {
    return this.service.read(principal, id, query);
  }
  @Post()
  @Roles('clinician')
  @HttpCode(201)
  record(
    @CurrentPrincipal() principal: Principal,
    @Param(new ZodValidationPipe(idParamSchema)) { id }: IdParam,
    @Body(new ZodValidationPipe(patientMedicationInputSchema)) body: PatientMedicationInput,
  ) {
    return this.service.record(principal, id, body);
  }
}
