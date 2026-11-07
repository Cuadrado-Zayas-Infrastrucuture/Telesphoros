import type { UsageDaysDto } from '@telesphoros/shared-types';

/**
 * Layout for the Usage calendar (specs/028-usage-heatmap). Pure, so it is tested without a browser. Dates stay `YYYY-MM-DD` strings in
 * Puerto Rico time as the API gives them; the only arithmetic is on calendar days, done in UTC so no time zone can shift a day.
 */

/** A day's cell: counted (shade 1 to 4), counted with no uploads, or one that cannot have counts (after today or before the organization). */
export type DayCell = { kind: 'counted'; date: string; count: number; shade: 1 | 2 | 3 | 4 } | { kind: 'zero'; date: string } | { kind: 'not-counted'; date: string };

export interface CalendarWeek {
  /** Seven slots, Sunday to Saturday; `null` pads the first and last weeks outside the year. */
  days: Array<DayCell | null>;
  /** The month that starts in this week, as its short name, for the label above the column. */
  monthLabel?: string;
}

export interface MonthTotal {
  month: string;
  /** `null` when no day of the month can have counts. */
  reportsUploaded: number | null;
}

export interface UsageCalendar {
  weeks: CalendarWeek[];
  months: MonthTotal[];
  total: number;
  busiest?: { date: string; count: number };
}

const DAY = 86_400_000;
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const isoDate = (time: number) => new Date(time).toISOString().slice(0, 10);

/** D8: zero apart, then four steps that split 1 up to the year's busiest day evenly. */
export function shadeFor(count: number, busiest: number): 1 | 2 | 3 | 4 {
  return Math.min(4, Math.max(1, Math.ceil((4 * count) / busiest))) as 1 | 2 | 3 | 4;
}

export function buildUsageCalendar({ year, firstDate, today, days }: UsageDaysDto): UsageCalendar {
  const counts = new Map(days.map((day) => [day.date, day.reportsUploaded]));
  const busiestCount = Math.max(0, ...days.map((day) => day.reportsUploaded));
  const start = Date.UTC(year, 0, 1);
  const end = Date.UTC(year + 1, 0, 1);

  const cells: DayCell[] = [];
  for (let time = start; time < end; time += DAY) {
    const date = isoDate(time);
    const count = counts.get(date);
    if (date > today || date < firstDate) cells.push({ kind: 'not-counted', date });
    else if (count) cells.push({ kind: 'counted', date, count, shade: shadeFor(count, busiestCount) });
    else cells.push({ kind: 'zero', date });
  }

  const slots: Array<DayCell | null> = [...Array<null>(new Date(start).getUTCDay()).fill(null), ...cells];
  while (slots.length % 7 !== 0) slots.push(null);
  const weeks: CalendarWeek[] = [];
  for (let index = 0; index < slots.length; index += 7) {
    const week = slots.slice(index, index + 7);
    const first = week.find((cell) => cell !== null && cell.date.endsWith('-01'));
    weeks.push({ days: week, ...(first ? { monthLabel: SHORT_MONTHS[Number(first.date.slice(5, 7)) - 1] } : {}) });
  }

  const months = MONTH_NAMES.map((name, index) => {
    const inMonth = cells.filter((cell) => Number(cell.date.slice(5, 7)) === index + 1);
    const counted = inMonth.filter((cell) => cell.kind !== 'not-counted');
    return { month: name, reportsUploaded: counted.length === 0 ? null : counted.reduce((sum, cell) => sum + (cell.kind === 'counted' ? cell.count : 0), 0) };
  });

  const busiest = days.reduce<{ date: string; count: number } | undefined>(
    (best, day) => (best === undefined || day.reportsUploaded > best.count ? { date: day.date, count: day.reportsUploaded } : best),
    undefined,
  );
  return { weeks, months, total: days.reduce((sum, day) => sum + day.reportsUploaded, 0), ...(busiest ? { busiest } : {}) };
}

/** `2026-05-14` as "Thursday, 14 May 2026". Read as a calendar date (UTC midnight), so it is never shifted. */
export function dayName(date: string): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(year, month - 1, day)));
  return `${weekday}, ${day} ${MONTH_NAMES[month - 1]} ${year}`;
}

/** The years the picker offers (D5): from the organization's first year to this one, newest first. */
export function calendarYears({ firstDate, today }: Pick<UsageDaysDto, 'firstDate' | 'today'>): number[] {
  const first = Number(firstDate.slice(0, 4));
  return Array.from({ length: Number(today.slice(0, 4)) - first + 1 }, (_, index) => Number(today.slice(0, 4)) - index);
}
