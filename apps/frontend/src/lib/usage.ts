import { type UsageDto, usageDtoSchema } from '@telesphoros/shared-types';
import { NotSignedInError, SessionEndedError } from '@/auth/AuthProvider';
// Type only, as in organizationProfile.ts: importing `./api` at run time would pull upload code into this page's chunk.
import type { ApiFetch } from './api';

export type UsageReport = { state: 'ready'; usage: UsageDto } | { state: 'unavailable' };

export class UsageLoadError extends Error {}

/** `GET /usage` (admin only). An older backend answers 404: that is "not available here", not a failure. */
export async function loadUsage(apiFetch: ApiFetch, signal?: AbortSignal): Promise<UsageReport> {
  try {
    const response = await apiFetch('/api/v1/usage', { signal });
    if (response.status === 404) return { state: 'unavailable' };
    if (!response.ok) throw new Error();
    return { state: 'ready', usage: usageDtoSchema.parse(await response.json()) };
  } catch (error) {
    if (signal?.aborted || error instanceof SessionEndedError || error instanceof NotSignedInError) throw error;
    throw new UsageLoadError('Usage could not be loaded. Please retry.');
  }
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** `2026-10` as "October 2026". The API names the month in Puerto Rico time, so no time zone conversion happens here. */
export function monthName(month: string): string {
  const [year, index] = month.split('-').map(Number) as [number, number];
  return `${MONTH_NAMES[index - 1]} ${year}`;
}

const counts = new Intl.NumberFormat('en-US');
export const formatCount = (value: number) => counts.format(value);

/** Bytes in decimal units (1 kB = 1,000 bytes), as storage is usually billed and shown. */
export function formatBytes(bytes: number): string {
  const units = ['bytes', 'kB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  if (unit === 0) return `${counts.format(value)} ${value === 1 ? 'byte' : 'bytes'}`;
  return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: value < 10 ? 1 : 0 }).format(value)} ${units[unit]}`;
}
