import { Controller, Get, Param, Query } from '@nestjs/common';
import { type GenomicProfileDto, genomicProfileDtoSchema, type GenomicProfileQuery, genomicProfileQuerySchema, type IdParam, idParamSchema } from '@telesphoros/shared-types';
import { CLINICAL_READ_ROLES } from '../auth/clinical-read';
import { CurrentPrincipal, Roles } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { RequiresPipelineOrSyntheticAssessment } from '../lab-reports/pipeline-switch';
import { GenomicProfileService } from './genomic-profile.service';

/**
 * `GET /patients/:id/genomic-profile` (spec 044 D7): read only, open where the evaluation reads are open (the pipeline or the synthetic
 * assessment), for the clinical read roles. The response is checked against its strict schema here, so a field added by mistake is refused.
 */
@Controller('patients/:id/genomic-profile')
@RequiresPipelineOrSyntheticAssessment()
export class GenomicProfileController {
  constructor(private readonly service: GenomicProfileService) {}

  @Get()
  @Roles(...CLINICAL_READ_ROLES)
  async get(
    @CurrentPrincipal() principal: Principal,
    @Param(new ZodValidationPipe(idParamSchema)) { id }: IdParam,
    @Query(new ZodValidationPipe(genomicProfileQuerySchema)) query: GenomicProfileQuery,
  ): Promise<GenomicProfileDto> {
    return genomicProfileDtoSchema.parse(await this.service.read(principal, id, query));
  }
}
