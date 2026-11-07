import { Controller, Get, Query } from '@nestjs/common';
import { type UsageDaysDto, type UsageDaysQuery, usageDaysQuerySchema, type UsageDto } from '@telesphoros/shared-types';
import { AppException } from '../common/app-exception';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { CurrentPrincipal, Roles } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { UsageRepository } from '../storage/usage.repository';
import { puertoRicoDate, USAGE_TIME_ZONE, usageWindows, usageYear } from './usage-months';

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

  /**
   * Reports uploaded per Puerto Rico day of one calendar year (specs/028-usage-heatmap), for the Usage calendar. The year must lie between the one the
   * organization was created in and this one (D5); with none, it is this year.
   */
  @Get('days')
  @Roles('admin')
  async days(@CurrentPrincipal() principal: Principal, @Query(new ZodValidationPipe(usageDaysQuerySchema)) query: UsageDaysQuery): Promise<UsageDaysDto> {
    const today = puertoRicoDate(new Date());
    const firstDate = puertoRicoDate(await this.usage.createdAt(principal.tenantId));
    const year = query.year ?? Number(today.slice(0, 4));
    if (year < Number(firstDate.slice(0, 4)) || year > Number(today.slice(0, 4))) {
      throw AppException.validation([{ field: 'year', message: "Choose a year from the organization's first year to this one." }]);
    }
    const { from, to } = usageYear(year);
    return { timeZone: USAGE_TIME_ZONE, year, firstDate, today, days: await this.usage.uploadsByDay(principal.tenantId, from, to) };
  }
}
