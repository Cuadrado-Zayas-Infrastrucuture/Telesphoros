import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  buildMeta,
  type IdParam,
  idParamSchema,
  type Paginated,
  type RecommendationDto,
  type RecommendationListQuery,
  recommendationListQuerySchema,
} from '@telesphoros/shared-types';
import { CurrentPrincipal } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { toRecommendationDto } from './recommendations.mapper';
import { RecommendationsService } from './recommendations.service';

@Controller('recommendations')
export class RecommendationsController {
  constructor(private readonly service: RecommendationsService) {}

  @Get()
  async list(
    @CurrentPrincipal() principal: Principal,
    @Query(new ZodValidationPipe(recommendationListQuerySchema)) query: RecommendationListQuery,
  ): Promise<Paginated<RecommendationDto>> {
    const { items, total } = await this.service.list(principal, query);
    return { data: items.map(toRecommendationDto), meta: buildMeta(query.page, query.pageSize, total) };
  }

  @Get(':id')
  async get(
    @CurrentPrincipal() principal: Principal,
    @Param(new ZodValidationPipe(idParamSchema)) { id }: IdParam,
  ): Promise<RecommendationDto> {
    return toRecommendationDto(await this.service.get(principal, id));
  }
}
