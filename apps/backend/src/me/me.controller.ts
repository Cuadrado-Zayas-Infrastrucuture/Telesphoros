import { Controller, Get } from '@nestjs/common';
import type { MeDto } from '@telesphoros/shared-types';
import { CurrentPrincipal } from '../auth/decorators';
import type { Principal } from '../auth/principal';

/**
 * What the signed-in caller may do. The frontend uses this to decide what to SHOW; the server
 * enforces every permission regardless. Returns roles only: no id, no email.
 */
@Controller('me')
export class MeController {
  @Get()
  me(@CurrentPrincipal() principal: Principal): MeDto {
    return { roles: principal.roles };
  }
}
