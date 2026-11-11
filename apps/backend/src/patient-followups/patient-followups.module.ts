import { Body, Controller, Get, HttpCode, Inject, Injectable, Module, Param, Post, Query } from '@nestjs/common';
import {
  followupInputSchema,
  followupInboxQuerySchema,
  followupQuerySchema,
  followupSummaryQuerySchema,
  idParamSchema,
  FOLLOWUP_WRITES_PAUSED,
  type FollowupAvailability,
  type FollowupInput,
  type FollowupInboxQuery,
  type FollowupQuery,
  type IdParam,
} from '@telesphoros/shared-types';
import { CurrentPrincipal, Roles } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AppException } from '../common/app-exception';
import { ENV, type Env } from '../config/env';
import { PatientsRepository } from '../storage/patients.repository';
import { PatientFollowupsRepository } from '../storage/patient-followups.repository';
@Injectable()
class FollowupsService {
  constructor(
    readonly records: PatientFollowupsRepository,
    private readonly patients: PatientsRepository,
    @Inject(ENV) private readonly env: Env,
  ) {}
  /** One rule for the write refusal and for what the availability read reports, so the two cannot disagree. */
  recordingEnabled() {
    return this.env.FOLLOWUP_WRITES === 'enabled' && this.env.NODE_ENV !== 'production';
  }
  async patient(principal: Principal, id: string) {
    if (!(await this.patients.findById(principal.tenantId, id))) throw AppException.notFound('Patient not found.');
  }
  async record(principal: Principal, id: string, input: FollowupInput) {
    await this.patient(principal, id);
    if (!this.recordingEnabled()) {
      const message = 'Follow-up recording is paused. Your entries can be retried later.';
      throw AppException.unavailable(message, [{ field: 'request', reason: FOLLOWUP_WRITES_PAUSED, message }]);
    }
    return this.records.record(principal.tenantId, principal.sub, id, input);
  }
}
@Controller('patients/:id/followups')
class PatientFollowupsController {
  constructor(private readonly service: FollowupsService) {}
  @Get()
  @Roles('clinician', 'reviewer')
  async read(
    @CurrentPrincipal() principal: Principal,
    @Param(new ZodValidationPipe(idParamSchema)) { id }: IdParam,
    @Query(new ZodValidationPipe(followupQuerySchema)) query: FollowupQuery,
  ) {
    await this.service.patient(principal, id);
    return this.service.records.read(principal.tenantId, id, query, principal.sub);
  }
  @Post()
  @Roles('clinician')
  @HttpCode(201)
  record(
    @CurrentPrincipal() principal: Principal,
    @Param(new ZodValidationPipe(idParamSchema)) { id }: IdParam,
    @Body(new ZodValidationPipe(followupInputSchema)) input: FollowupInput,
  ) {
    return this.service.record(principal, id, input);
  }
}
@Controller('followups')
class FollowupsController {
  constructor(private readonly service: FollowupsService) {}
  @Get('summary')
  @Roles('clinician', 'reviewer')
  summary(@CurrentPrincipal() principal: Principal, @Query(new ZodValidationPipe(followupSummaryQuerySchema)) _query: Record<string, never>) {
    void _query; // The empty query contract is validated by the pipe; no client-supplied scope is accepted.
    return this.service.records.summary(principal.tenantId);
  }
  @Get('assignees')
  @Roles('clinician', 'reviewer')
  async assignees(@CurrentPrincipal() principal: Principal) {
    return { currentActor: principal.sub, items: await this.service.records.assignees(principal.tenantId) };
  }
  /** Lets the page say "not available here" before a clinician fills a form that cannot be saved. Tells nothing about any patient. */
  @Get('availability')
  @Roles('clinician', 'reviewer')
  availability(): FollowupAvailability {
    return { recording: this.service.recordingEnabled() ? 'enabled' : 'paused' };
  }
  @Get()
  @Roles('clinician', 'reviewer')
  read(@CurrentPrincipal() principal: Principal, @Query(new ZodValidationPipe(followupInboxQuerySchema)) query: FollowupInboxQuery) {
    return this.service.records.read(principal.tenantId, null, query, principal.sub);
  }
}
@Module({ controllers: [PatientFollowupsController, FollowupsController], providers: [FollowupsService] })
export class PatientFollowupsModule {}
