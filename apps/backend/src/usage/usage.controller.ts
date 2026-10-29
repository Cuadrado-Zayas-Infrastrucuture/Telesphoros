import { Controller, Get } from '@nestjs/common';
import type { UsageDto } from '@telesphoros/shared-types';
import { CurrentPrincipal, Roles } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { UsageRepository } from '../storage/usage.repository';
import { USAGE_TIME_ZONE, usageWindows } from './usage-months';

/**
 * The caller's own organization's usage, for its administrators (specs/010-usage). Counts only: nothing clinical and no ids, so it suits the
 * `admin` role, which sees no clinical data. There is no organization argument: it is always the caller's.
 */
@Controller('usage')
export class UsageController {
  constructor(private readonly usage: UsageRepository) {}

  @Get()
  @Roles('admin')
  async get(@CurrentPrincipal() principal: Principal): Promise<UsageDto> {
    const [current, previous] = usageWindows(new Date());
    const month = async ({ month, from, to }: { month: string; from: Date; to: Date }) => {
      const { reportsUploaded, evaluated, held } = await this.usage.activity(principal.tenantId, from, to);
      return { month, reportsUploaded, evaluations: { evaluated, held } };
    };
    return { timeZone: USAGE_TIME_ZONE, months: [await month(current), await month(previous)], storage: await this.usage.storage(principal.tenantId) };
  }
}
