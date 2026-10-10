import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  type Paginated,
  type CellUsageDto, type CellUsageQuery, cellUsageQuerySchema, type DisputeCreate, disputeCreateSchema, type DisputeDecisionCreate, disputeDecisionCreateSchema, type DisputeDto, type DisputeListQuery, disputeListQuerySchema, type IdParam, idParamSchema,
} from '@telesphoros/shared-types';
import { CurrentPrincipal, Roles } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { DisputesService } from './disputes.service';
import { RequiresPipeline } from './pipeline-switch';

/** Disputes about guideline cells. Reading is open to every signed-in role; raising and deciding are for a reviewer (and never the same one). */
@Controller('cell-disputes')
@RequiresPipeline()
export class DisputesController {
  constructor(private readonly disputes: DisputesService) {}

  @Post()
  @HttpCode(201)
  @Roles('reviewer')
  raise(@CurrentPrincipal() principal: Principal, @Body(new ZodValidationPipe(disputeCreateSchema)) body: DisputeCreate): Promise<DisputeDto> {
    return this.disputes.raise(principal, body);
  }

  @Post(':id/decision')
  @HttpCode(201)
  @Roles('reviewer')
  decide(
    @CurrentPrincipal() principal: Principal,
    @Param(new ZodValidationPipe(idParamSchema)) { id }: IdParam,
    @Body(new ZodValidationPipe(disputeDecisionCreateSchema)) body: DisputeDecisionCreate,
  ): Promise<DisputeDto> {
    return this.disputes.decide(principal, id, body);
  }

  @Get()
  list(@CurrentPrincipal() principal: Principal, @Query(new ZodValidationPipe(disputeListQuerySchema)) query: DisputeListQuery): Promise<Paginated<DisputeDto>> {
    return this.disputes.list(principal, query);
  }

  @Get(':id/evaluations')
  @Roles('clinician', 'reviewer', 'admin')
  evaluations(
    @CurrentPrincipal() principal: Principal,
    @Param(new ZodValidationPipe(idParamSchema)) { id }: IdParam,
    @Query(new ZodValidationPipe(cellUsageQuerySchema)) query: CellUsageQuery,
  ): Promise<CellUsageDto> {
    return this.disputes.evaluations(principal, id, query);
  }

  @Get(':id')
  get(@CurrentPrincipal() principal: Principal, @Param(new ZodValidationPipe(idParamSchema)) { id }: IdParam): Promise<DisputeDto> {
    return this.disputes.get(principal, id);
  }
}
