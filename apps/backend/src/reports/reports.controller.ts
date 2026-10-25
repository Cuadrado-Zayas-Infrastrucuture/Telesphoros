import { SetMetadata, Req, Res, Put, Headers } from '@nestjs/common';
import type { Request, Response } from 'express';
import { FILE_LINK_ROLES } from '../auth/file-access';
import { RateLimitClass } from '../rate-limit/rate-limit.decorators';
import { RAW_INTAKE } from './intake/raw-intake';
import { IntakeService } from './intake/intake.service';
import { attemptDeclarationSchema, attemptParamsSchema, type AttemptDeclaration, type AttemptParams } from './intake/contracts';
import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import {
  buildMeta,
  type IdParam,
  idParamSchema,
  type Paginated,
  type ReportCreate,
  reportCreateSchema,
  type ReportDto,
  type ReportListQuery,
  reportListQuerySchema,
  type ReportPatch,
  reportPatchSchema,
} from '@telesphoros/shared-types';
import { CLINICAL_READ_ROLES } from '../auth/clinical-read';
import { CurrentPrincipal, Roles } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { toReportDto } from './reports.mapper';
import { ReportsService } from './reports.service';

const CAN_WRITE = ['clinician'] as const;

@Controller('reports')
export class ReportsController {
  constructor(
    private readonly service: ReportsService,
    private readonly intake: IntakeService,
  ) {}

  @Get()
  @Roles(...CLINICAL_READ_ROLES)
  async list(@CurrentPrincipal() principal: Principal, @Query(new ZodValidationPipe(reportListQuerySchema)) query: ReportListQuery): Promise<Paginated<ReportDto>> {
    const { items, total } = await this.service.list(principal, query);
    return { data: items.map(toReportDto), meta: buildMeta(query.page, query.pageSize, total) };
  }

  @Get(':id')
  @Roles(...CLINICAL_READ_ROLES)
  async get(@CurrentPrincipal() principal: Principal, @Param(new ZodValidationPipe(idParamSchema)) { id }: IdParam): Promise<ReportDto> {
    return toReportDto(await this.service.get(principal, id));
  }

  @Post()
  @Roles(...CAN_WRITE)
  @HttpCode(201)
  async create(@CurrentPrincipal() principal: Principal, @Body(new ZodValidationPipe(reportCreateSchema)) body: ReportCreate): Promise<ReportDto> {
    return toReportDto(await this.service.create(principal, body));
  }

  @Patch(':id')
  @Roles(...CAN_WRITE)
  async patch(
    @CurrentPrincipal() principal: Principal,
    @Param(new ZodValidationPipe(idParamSchema)) { id }: IdParam,
    @Body(new ZodValidationPipe(reportPatchSchema)) body: ReportPatch,
  ): Promise<ReportDto> {
    return toReportDto(await this.service.patch(principal, id, body));
  }

  @Get(':id/download-url')
  @RateLimitClass('expensive')
  @Roles(...FILE_LINK_ROLES)
  downloadUrl(@CurrentPrincipal() principal: Principal, @Param(new ZodValidationPipe(idParamSchema)) { id }: IdParam, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'private, no-store');
    return this.service.downloadUrl(principal, id);
  }

  @Get(':id/upload-state')
  @Roles(...CAN_WRITE)
  uploadState(@CurrentPrincipal() p: Principal, @Param(new ZodValidationPipe(idParamSchema)) { id }: IdParam) {
    return this.intake.state(p, id);
  }

  @Post(':id/upload-attempts')
  @Roles(...CAN_WRITE)
  @HttpCode(201)
  declareAttempt(
    @CurrentPrincipal() p: Principal,
    @Param(new ZodValidationPipe(idParamSchema)) { id }: IdParam,
    @Body(new ZodValidationPipe(attemptDeclarationSchema)) input: AttemptDeclaration,
  ) {
    return this.intake.declare(p, id, input);
  }

  @Put(':id/upload-attempts/:attemptId/bytes')
  @SetMetadata(RAW_INTAKE, true)
  @Roles(...CAN_WRITE)
  @RateLimitClass('expensive')
  uploadBytes(
    @CurrentPrincipal() p: Principal,
    @Param(new ZodValidationPipe(attemptParamsSchema)) { id, attemptId }: AttemptParams,
    @Headers('x-upload-revision') revision: string,
    @Req() req: Request,
  ) {
    return this.intake.intake(p, id, attemptId, revision, req, req.headers);
  }

  @Post(':id/upload-attempts/:attemptId/resume')
  @Roles(...CAN_WRITE)
  @HttpCode(200)
  resumeAttempt(
    @CurrentPrincipal() p: Principal,
    @Param(new ZodValidationPipe(attemptParamsSchema)) { id, attemptId }: AttemptParams,
    @Headers('x-upload-revision') revision: string,
  ) {
    return this.intake.resume(p, id, attemptId, revision);
  }

  @Post(':id/upload-attempts/:attemptId/cancel')
  @Roles(...CAN_WRITE)
  @HttpCode(200)
  cancelAttempt(
    @CurrentPrincipal() p: Principal,
    @Param(new ZodValidationPipe(attemptParamsSchema)) { id, attemptId }: AttemptParams,
    @Headers('x-upload-revision') revision: string,
  ) {
    return this.intake.cancel(p, id, attemptId, revision);
  }

  @Delete(':id')
  @Roles(...CAN_WRITE)
  @HttpCode(204)
  async remove(@CurrentPrincipal() principal: Principal, @Param(new ZodValidationPipe(idParamSchema)) { id }: IdParam): Promise<void> {
    await this.service.remove(principal, id);
  }
}
