import { StructuredRecordsService } from './structured-records.service';
import {
  structuredFindingReviewCreateSchema,
  structuredRecordCreateSchema,
  structuredSourceResolutionCreateSchema,
  type StructuredFindingReviewCreate,
  type StructuredRecordCreate,
  type StructuredSourceResolutionCreate,
} from '@telesphoros/shared-types';
import { Body, CanActivate, Controller, Get, Injectable, Param, Post, Res, UseGuards } from '@nestjs/common';
import {
  idParamSchema,
  patientLinkDecisionDtoSchema,
  structuredPatientLinkSchema,
  structuredPreviewSchema,
  structuredRecordStateSchema,
  type IdParam,
  type StructuredPatientLink,
} from '@telesphoros/shared-types';
import type { Response } from 'express';
import { CurrentPrincipal, Roles } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RateLimitClass } from '../rate-limit/rate-limit.decorators';
import { UnlockedBySyntheticAssessment } from '../lab-reports/pipeline-switch';
import { StructuredPreviewService } from './structured-preview.service';

@Injectable()
export class StructuredPreviewGuard implements CanActivate {
  constructor(private readonly service: StructuredPreviewService) {}
  canActivate() {
    this.service.assertEnabled();
    return true;
  }
}

@Controller('reports/:id/structured-preview')
@UseGuards(StructuredPreviewGuard)
@UnlockedBySyntheticAssessment()
export class StructuredPreviewController {
  constructor(
    private readonly service: StructuredPreviewService,
    private readonly records: StructuredRecordsService,
  ) {}
  @Get()
  @Roles('clinician', 'reviewer')
  @RateLimitClass('expensive')
  async get(@CurrentPrincipal() principal: Principal, @Param(new ZodValidationPipe(idParamSchema)) { id }: IdParam) {
    return structuredPreviewSchema.parse(await this.service.get(principal, id));
  }

  @Get('record')
  @Roles('clinician', 'reviewer')
  @RateLimitClass('expensive')
  async record(@CurrentPrincipal() principal: Principal, @Param(new ZodValidationPipe(idParamSchema)) { id }: IdParam) {
    return structuredRecordStateSchema.parse(await this.records.get(principal, id));
  }
  @Post('record')
  @Roles('clinician', 'reviewer')
  @RateLimitClass('expensive')
  async saveRecord(
    @CurrentPrincipal() principal: Principal,
    @Param(new ZodValidationPipe(idParamSchema)) { id }: IdParam,
    @Body(new ZodValidationPipe(structuredRecordCreateSchema)) body: StructuredRecordCreate,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.records.save(principal, id, body);
    res.status(result.created ? 201 : 200);
    return structuredRecordStateSchema.parse(result.state);
  }

  @Post('review')
  @Roles('reviewer')
  @RateLimitClass('expensive')
  async reviewFinding(
    @CurrentPrincipal() principal: Principal,
    @Param(new ZodValidationPipe(idParamSchema)) { id }: IdParam,
    @Body(new ZodValidationPipe(structuredFindingReviewCreateSchema)) body: StructuredFindingReviewCreate,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.records.review(principal, id, body);
    res.status(result.created ? 201 : 200);
    return structuredRecordStateSchema.parse(result.state);
  }
  @Post('source-resolution')
  @Roles('reviewer')
  @RateLimitClass('expensive')
  async resolveSources(
    @CurrentPrincipal() principal: Principal,
    @Param(new ZodValidationPipe(idParamSchema)) { id }: IdParam,
    @Body(new ZodValidationPipe(structuredSourceResolutionCreateSchema)) body: StructuredSourceResolutionCreate,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.records.resolve(principal, id, body);
    res.status(result.created ? 201 : 200);
    return structuredRecordStateSchema.parse(result.state);
  }

  @Post('patient-link')
  @Roles('reviewer')
  @RateLimitClass('expensive')
  async decide(
    @CurrentPrincipal() principal: Principal,
    @Param(new ZodValidationPipe(idParamSchema)) { id }: IdParam,
    @Body(new ZodValidationPipe(structuredPatientLinkSchema)) body: StructuredPatientLink,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.service.decide(principal, id, body);
    res.status(result.created ? 201 : 200);
    return patientLinkDecisionDtoSchema.parse(result.decision);
  }
}
