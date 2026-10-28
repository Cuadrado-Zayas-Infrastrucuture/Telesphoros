/**
 * Usage is counted by calendar month in Puerto Rico time (specs/010-usage D2). Puerto Rico is UTC−4 all year, with no daylight saving, so a
 * month there runs from 04:00 UTC on its first day to 04:00 UTC on the next month's first day. A fixed offset keeps the windows exact and
 * free of time-zone data; if Puerto Rico ever adopted daylight saving, this is the one place to change.
 */
export const USAGE_TIME_ZONE = 'America/Puerto_Rico';
const OFFSET_HOURS = 4;

export interface UsageWindow {
  /** `YYYY-MM` in Puerto Rico. */
  month: string;
  /** Inclusive start and exclusive end, as instants. */
  from: Date;
  to: Date;
}

function window(year: number, monthIndex: number): UsageWindow {
  const from = new Date(Date.UTC(year, monthIndex, 1, OFFSET_HOURS));
  const to = new Date(Date.UTC(year, monthIndex + 1, 1, OFFSET_HOURS));
  return { month: `${from.getUTCFullYear()}-${String(from.getUTCMonth() + 1).padStart(2, '0')}`, from, to };
}

/** This month (in Puerto Rico at `now`), then last month. */
export function usageWindows(now: Date): [UsageWindow, UsageWindow] {
  const local = new Date(now.getTime() - OFFSET_HOURS * 3_600_000);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth();
  return [window(year, month), window(year, month - 1)];
}
