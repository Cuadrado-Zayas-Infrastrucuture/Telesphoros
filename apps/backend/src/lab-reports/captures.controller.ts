import { Body, Controller, Get, HttpCode, Param, Post, Res } from '@nestjs/common';
import {
  type AcceptanceDto,
  type CaptureDto,
  type DecisionCreate,
  decisionCreateSchema,
  type FileLinkDto,
  type IdParam,
  idParamSchema,
} from '@telesphoros/shared-types';
import type { Response } from 'express';
import { CurrentPrincipal, Roles } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CapturesService } from './captures.service';
import { RequiresPipeline } from './pipeline-switch';

const CAN_CAPTURE = ['clinician', 'reviewer', 'admin'] as const;
const CAN_REVIEW = ['reviewer'] as const;

/** `POST /reports/:id/capture` and `GET /reports/:id/download-url`: the report-side routes of the pipeline. */
@Controller('reports')
@RequiresPipeline()
export class ReportCaptureController {
  constructor(private readonly captures: CapturesService) {}

  /** 201 for a new capture, 200 when the same text had already been captured (the same record comes back). */
  @Post(':id/capture')
  @Roles(...CAN_CAPTURE)
  async capture(
    @CurrentPrincipal() principal: Principal,
    @Param(new ZodValidationPipe(idParamSchema)) { id }: IdParam,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CaptureDto> {
    const { capture, created } = await this.captures.capture(principal, id);
    res.status(created ? 201 : 200);
    return capture;
  }

  @Get(':id/download-url')
  @Roles(...CAN_CAPTURE)
  downloadUrl(@CurrentPrincipal() principal: Principal, @Param(new ZodValidationPipe(idParamSchema)) { id }: IdParam): Promise<FileLinkDto> {
    return this.captures.pdfLink(principal, id);
  }
}

@Controller('captures')
@RequiresPipeline()
export class CapturesController {
  constructor(private readonly captures: CapturesService) {}

  @Get(':id')
  get(@CurrentPrincipal() principal: Principal, @Param(new ZodValidationPipe(idParamSchema)) { id }: IdParam): Promise<CaptureDto> {
    return this.captures.get(principal, id);
  }

  @Get(':id/text-url')
  @Roles(...CAN_CAPTURE)
  textUrl(@CurrentPrincipal() principal: Principal, @Param(new ZodValidationPipe(idParamSchema)) { id }: IdParam): Promise<FileLinkDto> {
    return this.captures.textLink(principal, id);
  }

  @Post(':id/decision')
  @Roles(...CAN_REVIEW)
  @HttpCode(201)
  decide(
    @CurrentPrincipal() principal: Principal,
    @Param(new ZodValidationPipe(idParamSchema)) { id }: IdParam,
    @Body(new ZodValidationPipe(decisionCreateSchema)) body: DecisionCreate,
  ): Promise<AcceptanceDto> {
    return this.captures.decide(principal, id, body);
  }
}
