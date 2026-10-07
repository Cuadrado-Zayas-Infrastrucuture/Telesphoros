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
  type ReportUploadUrlRequest,
  reportUploadUrlRequestSchema,
  type ReportUploadUrlResponse,
} from '@telesphoros/shared-types';
import { CurrentPrincipal, Roles } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { toReportDto } from './reports.mapper';
import { ReportsService } from './reports.service';

const CAN_WRITE = ['clinician', 'admin'] as const;

@Controller('reports')
export class ReportsController {
  constructor(private readonly service: ReportsService) {}

  @Get()
  async list(
    @CurrentPrincipal() principal: Principal,
    @Query(new ZodValidationPipe(reportListQuerySchema)) query: ReportListQuery,
  ): Promise<Paginated<ReportDto>> {
    const { items, total } = await this.service.list(principal, query);
    return { data: items.map(toReportDto), meta: buildMeta(query.page, query.pageSize, total) };
  }

  @Get(':id')
  async get(
    @CurrentPrincipal() principal: Principal,
    @Param(new ZodValidationPipe(idParamSchema)) { id }: IdParam,
  ): Promise<ReportDto> {
    return toReportDto(await this.service.get(principal, id));
  }

  @Post()
  @Roles(...CAN_WRITE)
  @HttpCode(201)
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(reportCreateSchema)) body: ReportCreate,
  ): Promise<ReportDto> {
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

  /** Upload step 1: get a short-lived URL to PUT the file to. */
  @Post(':id/upload-url')
  @Roles(...CAN_WRITE)
  @HttpCode(200)
  createUploadUrl(
    @CurrentPrincipal() principal: Principal,
    @Param(new ZodValidationPipe(idParamSchema)) { id }: IdParam,
    @Body(new ZodValidationPipe(reportUploadUrlRequestSchema)) body: ReportUploadUrlRequest,
  ): Promise<ReportUploadUrlResponse> {
    return this.service.createUploadUrl(principal, id, body);
  }

  /** Upload step 2: the server verifies the stored file (size, type, SHA-256), then marks it uploaded. */
  @Post(':id/complete')
  @Roles(...CAN_WRITE)
  @HttpCode(200)
  async complete(
    @CurrentPrincipal() principal: Principal,
    @Param(new ZodValidationPipe(idParamSchema)) { id }: IdParam,
  ): Promise<ReportDto> {
    return toReportDto(await this.service.completeUpload(principal, id));
  }

  @Delete(':id')
  @Roles(...CAN_WRITE)
  @HttpCode(204)
  async remove(
    @CurrentPrincipal() principal: Principal,
    @Param(new ZodValidationPipe(idParamSchema)) { id }: IdParam,
  ): Promise<void> {
    await this.service.remove(principal, id);
  }
}
