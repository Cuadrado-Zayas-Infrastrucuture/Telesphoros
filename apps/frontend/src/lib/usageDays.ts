import { type UsageDaysDto, usageDaysDtoSchema } from '@telesphoros/shared-types';
import { NotSignedInError, SessionEndedError } from '@/auth/AuthProvider';
// Type only, as in usage.ts: importing `./api` at run time would pull upload code into this page's chunk.
import type { ApiFetch } from './api';
import { UsageLoadError } from './usage';

export type UsageDaysReport = { state: 'ready'; days: UsageDaysDto } | { state: 'unavailable' };

/**
 * `GET /usage/days` (admin only, specs/028-usage-heatmap) for one calendar year, or this Puerto Rico year when `year` is left out. An older
 * backend answers 404: that is "not available here", not a failure.
 */
export async function loadUsageDays(apiFetch: ApiFetch, year: number | undefined, signal?: AbortSignal): Promise<UsageDaysReport> {
  try {
    const response = await apiFetch(year === undefined ? '/api/v1/usage/days' : `/api/v1/usage/days?year=${year}`, { signal });
    if (response.status === 404) return { state: 'unavailable' };
    if (!response.ok) throw new Error();
    return { state: 'ready', days: usageDaysDtoSchema.parse(await response.json()) };
  } catch (error) {
    if (signal?.aborted || error instanceof SessionEndedError || error instanceof NotSignedInError) throw error;
    throw new UsageLoadError('The calendar could not be loaded. Please retry.');
  }
}
