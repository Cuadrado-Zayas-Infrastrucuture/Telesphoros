import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import {
  type DuplicateCandidateDto,
  type IdParam,
  idParamSchema,
  type Paginated,
  type PaginationQuery,
  paginationQuerySchema,
  type PatientMergeCreate,
  patientMergeCreateSchema,
  type PatientMergeDecisionCreate,
  patientMergeDecisionCreateSchema,
  type PatientMergeDto,
  type PatientMergeListQuery,
  patientMergeListQuerySchema,
} from '@telesphoros/shared-types';
import type { Response } from 'express';
import { CLINICAL_READ_ROLES } from '../auth/clinical-read';
import { CurrentPrincipal, Roles } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RateLimitClass } from '../rate-limit/rate-limit.decorators';
import { PatientMergeService } from './patient-merge.service';

// Proposing and deciding change what a patient's records look like together: clinician or reviewer. An administrator alone has none of these.
const CAN_MERGE = ['clinician', 'reviewer'] as const;

/** The possible duplicates to review: pairs of patients whose identifiers collided. */
@Controller('patient-duplicates')
export class PatientDuplicatesController {
  constructor(private readonly service: PatientMergeService) {}

  @Get()
  @Roles(...CLINICAL_READ_ROLES)
  list(@CurrentPrincipal() principal: Principal, @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery): Promise<Paginated<DuplicateCandidateDto>> {
    return this.service.duplicates(principal, query);
  }
}

@Controller('patient-merges')
export class PatientMergesController {
  constructor(private readonly service: PatientMergeService) {}

  @Post()
  @RateLimitClass('expensive')
  @Roles(...CAN_MERGE)
  async propose(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(patientMergeCreateSchema)) body: PatientMergeCreate,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PatientMergeDto> {
    res.status(201);
    return this.service.propose(principal, body);
  }

  @Get()
  @Roles(...CLINICAL_READ_ROLES)
  list(@CurrentPrincipal() principal: Principal, @Query(new ZodValidationPipe(patientMergeListQuerySchema)) query: PatientMergeListQuery): Promise<Paginated<PatientMergeDto>> {
    return this.service.list(principal, query);
  }

  @Get(':id')
  @Roles(...CLINICAL_READ_ROLES)
  get(@CurrentPrincipal() principal: Principal, @Param(new ZodValidationPipe(idParamSchema)) { id }: IdParam): Promise<PatientMergeDto> {
    return this.service.get(principal, id);
  }

  /** 201 for a new decision, 200 when the proposal already has exactly this decision. */
  @Post(':id/decision')
  @RateLimitClass('expensive')
  @Roles(...CAN_MERGE)
  async decide(
    @CurrentPrincipal() principal: Principal,
    @Param(new ZodValidationPipe(idParamSchema)) { id }: IdParam,
    @Body(new ZodValidationPipe(patientMergeDecisionCreateSchema)) body: PatientMergeDecisionCreate,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PatientMergeDto> {
    const { merge, created } = await this.service.decide(principal, id, body);
    res.status(created ? 201 : 200);
    return merge;
  }
}
