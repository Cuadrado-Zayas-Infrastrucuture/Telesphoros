import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import {
  buildMeta,
  type DemographicsCompleteness,
  type IdParam,
  idParamSchema,
  type Paginated,
  type PatientDto,
  type PatientCreate,
  type PatientInput,
  patientCreateSchema,
  patientInputSchema,
  type PatientListQuery,
  patientListQuerySchema,
} from '@telesphoros/shared-types';
import { CLINICAL_READ_ROLES } from '../auth/clinical-read';
import { CurrentPrincipal, Roles } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { toPatientDto, toPatientListItemDto } from './patients.mapper';
import { PatientsService } from './patients.service';

// Reading needs a clinical role; changing data needs the clinician role (admin is administration only).
const CAN_WRITE = ['clinician'] as const;

@Controller('patients')
export class PatientsController {
  constructor(private readonly service: PatientsService) {}

  @Get()
  @Roles(...CLINICAL_READ_ROLES)
  async list(@CurrentPrincipal() principal: Principal, @Query(new ZodValidationPipe(patientListQuerySchema)) query: PatientListQuery): Promise<Paginated<PatientDto>> {
    const { items, total } = await this.service.list(principal, query);
    return { data: items.map((item) => toPatientListItemDto(item)), meta: buildMeta(query.page, query.pageSize, total) };
  }

  /** Declared before `:id`, so the word is never read as an id. */
  @Get('demographics-completeness')
  @Roles(...CLINICAL_READ_ROLES)
  completeness(@CurrentPrincipal() principal: Principal): Promise<DemographicsCompleteness> {
    return this.service.completeness(principal);
  }

  @Get(':id')
  @Roles(...CLINICAL_READ_ROLES)
  async get(@CurrentPrincipal() principal: Principal, @Param(new ZodValidationPipe(idParamSchema)) { id }: IdParam): Promise<PatientDto> {
    return toPatientDto(await this.service.get(principal, id));
  }

  @Post()
  @Roles(...CAN_WRITE)
  @HttpCode(201)
  async create(@CurrentPrincipal() principal: Principal, @Body(new ZodValidationPipe(patientCreateSchema)) body: PatientCreate): Promise<PatientDto> {
    return toPatientDto(await this.service.create(principal, body));
  }

  @Put(':id')
  @Roles(...CAN_WRITE)
  async replace(
    @CurrentPrincipal() principal: Principal,
    @Param(new ZodValidationPipe(idParamSchema)) { id }: IdParam,
    @Body(new ZodValidationPipe(patientInputSchema)) body: PatientInput,
  ): Promise<PatientDto> {
    return toPatientDto(await this.service.replace(principal, id, body));
  }

  @Delete(':id')
  @Roles(...CAN_WRITE)
  @HttpCode(204)
  async remove(@CurrentPrincipal() principal: Principal, @Param(new ZodValidationPipe(idParamSchema)) { id }: IdParam): Promise<void> {
    await this.service.remove(principal, id);
  }
}
