import { Controller, Get, HttpCode, Post } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { MeDto, RecoveryScopeDto } from '@telesphoros/shared-types';
import { CurrentPrincipal } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { MemberAdminRepository } from '../storage/member-admin.repository';

/**
 * What the signed-in caller may do. The frontend uses this to decide what to SHOW; the server
 * enforces every permission regardless. Keep this response unchanged for old and cached clients.
 */
@Controller('me')
export class MeController {
  constructor(private readonly members: MemberAdminRepository) {}

  @Get()
  me(@CurrentPrincipal() principal: Principal): MeDto {
    return { roles: principal.roles };
  }

  /** Verified caller/tenant recovery binding, never an authorization credential or a raw identity. */
  @Get('recovery-scope')
  recoveryScope(@CurrentPrincipal() principal: Principal): RecoveryScopeDto {
    const recoveryScope = createHash('sha256')
      .update(JSON.stringify(['telesphoros-upload-recovery-v2', principal.tenantId, principal.sub]))
      .digest('hex');
    return { recoveryScope };
  }

  /** Ends the caller's sessions in this organization (AUTH-03): tokens issued before now are refused from the next request. Only the caller's own row changes. */
  @Post('sign-out')
  @HttpCode(204)
  signOut(@CurrentPrincipal() principal: Principal): Promise<void> {
    return this.members.signOut(principal);
  }
}
