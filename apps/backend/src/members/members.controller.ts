import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import {
  type IdParam,
  idParamSchema,
  type InvitationCreate,
  invitationCreateSchema,
  type InvitationDto,
  type MemberDto,
  type MemberParam,
  memberParamSchema,
  type MemberRolesInput,
  memberRolesInputSchema,
  type Paginated,
  type PaginationQuery,
  paginationQuerySchema,
} from '@telesphoros/shared-types';
import { CurrentPrincipal, Roles } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { MembersService } from './members.service';

/**
 * The people of the caller's own organization, for its administrators. `admin` is administration only: none of these routes touches clinical data,
 * and an administrator who also needs clinical access holds a clinical role as well. There is no route that creates an account or an organization.
 */
@Controller('members')
export class MembersController {
  constructor(private readonly service: MembersService) {}

  @Get()
  @Roles('admin')
  list(@CurrentPrincipal() principal: Principal, @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery): Promise<Paginated<MemberDto>> {
    return this.service.list(principal, query);
  }

  @Put(':sub/roles')
  @Roles('admin')
  @HttpCode(204)
  async changeRoles(
    @CurrentPrincipal() principal: Principal,
    @Param(new ZodValidationPipe(memberParamSchema)) { sub }: MemberParam,
    @Body(new ZodValidationPipe(memberRolesInputSchema)) body: MemberRolesInput,
  ): Promise<void> {
    await this.service.changeRoles(principal, sub, body);
  }

  @Delete(':sub')
  @Roles('admin')
  @HttpCode(204)
  async remove(@CurrentPrincipal() principal: Principal, @Param(new ZodValidationPipe(memberParamSchema)) { sub }: MemberParam): Promise<void> {
    await this.service.remove(principal, sub);
  }

  @Post('invitations')
  @Roles('admin')
  @HttpCode(201)
  invite(@CurrentPrincipal() principal: Principal, @Body(new ZodValidationPipe(invitationCreateSchema)) body: InvitationCreate): Promise<InvitationDto> {
    return this.service.invite(principal, body);
  }

  @Get('invitations')
  @Roles('admin')
  listInvitations(@CurrentPrincipal() principal: Principal, @Query(new ZodValidationPipe(paginationQuerySchema)) query: PaginationQuery): Promise<Paginated<InvitationDto>> {
    return this.service.listInvitations(principal, query);
  }

  @Delete('invitations/:id')
  @Roles('admin')
  @HttpCode(204)
  async cancelInvitation(@CurrentPrincipal() principal: Principal, @Param(new ZodValidationPipe(idParamSchema)) { id }: IdParam): Promise<void> {
    await this.service.cancelInvitation(principal, id);
  }
}
