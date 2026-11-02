import { Body, CanActivate, Controller, Get, Injectable, Param, Post, Res, UseGuards } from '@nestjs/common';
import { idParamSchema, structuredPatientLinkSchema, type IdParam, type StructuredPatientLink } from '@telesphoros/shared-types';
import type { Response } from 'express';
import { CurrentPrincipal, Roles } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RateLimitClass } from '../rate-limit/rate-limit.decorators';
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
export class StructuredPreviewController {
  constructor(private readonly service: StructuredPreviewService) {}
  @Get()
  @Roles('clinician', 'reviewer')
  @RateLimitClass('expensive')
  get(@CurrentPrincipal() principal: Principal, @Param(new ZodValidationPipe(idParamSchema)) { id }: IdParam) {
    return this.service.get(principal, id);
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
    return result.decision;
  }
}
