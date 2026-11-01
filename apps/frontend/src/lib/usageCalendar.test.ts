import type { UsageDaysDto } from '@telesphoros/shared-types';
import { describe, expect, it } from 'vitest';
import { buildUsageCalendar, calendarYears, dayName, shadeFor } from './usageCalendar';

const dto = (overrides: Partial<UsageDaysDto>): UsageDaysDto => ({
  timeZone: 'America/Puerto_Rico',
  year: 2026,
  firstDate: '2025-03-09',
  today: '2026-12-31',
  days: [],
  ...overrides,
});
const cells = (calendar: ReturnType<typeof buildUsageCalendar>) => calendar.weeks.flatMap((week) => week.days).filter((cell) => cell !== null);
const cell = (calendar: ReturnType<typeof buildUsageCalendar>, date: string) => cells(calendar).find((c) => c.date === date);

describe('usage calendar layout (specs/028-usage-heatmap)', () => {
  it('lays out 365 days in Sunday-to-Saturday weeks, starting 1 January on its weekday', () => {
    const calendar = buildUsageCalendar(dto({}));
    expect(cells(calendar)).toHaveLength(365);
    expect(calendar.weeks.every((week) => week.days.length === 7)).toBe(true);
    expect(calendar.weeks[0]!.days.slice(0, 4)).toEqual([null, null, null, null]); // 1 January 2026 is a Thursday
    expect(calendar.weeks[0]!.days[4]?.date).toBe('2026-01-01');
    expect(calendar.weeks.at(-1)!.days.findLast((c) => c !== null)?.date).toBe('2026-12-31');
  });

  it('gives a leap year 366 days', () => {
    const calendar = buildUsageCalendar(dto({ year: 2028, today: '2028-12-31' }));
    expect(cells(calendar)).toHaveLength(366);
    expect(cell(calendar, '2028-02-29')?.kind).toBe('zero');
  });

  it('marks days after today and before the organization existed as not counted, distinct from zero', () => {
    const calendar = buildUsageCalendar(dto({ year: 2025, firstDate: '2025-03-09', today: '2025-10-31' }));
    expect(cell(calendar, '2025-03-08')?.kind).toBe('not-counted');
    expect(cell(calendar, '2025-03-09')?.kind).toBe('zero');
    expect(cell(calendar, '2025-10-31')?.kind).toBe('zero');
    expect(cell(calendar, '2025-11-01')?.kind).toBe('not-counted');
  });

  it('labels the week each month starts in', () => {
    const labels = buildUsageCalendar(dto({})).weeks.flatMap((week) => (week.monthLabel ? [week.monthLabel] : []));
    expect(labels).toEqual(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
  });

  it('shades in four even steps up to the busiest day (D8)', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((count) => shadeFor(count, 8))).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
    const calendar = buildUsageCalendar(
      dto({
        days: [
          { date: '2026-05-14', reportsUploaded: 9 },
          { date: '2026-05-15', reportsUploaded: 2 },
        ],
      }),
    );
    expect(cell(calendar, '2026-05-14')).toEqual({ kind: 'counted', date: '2026-05-14', count: 9, shade: 4 });
    expect(cell(calendar, '2026-05-15')).toEqual({ kind: 'counted', date: '2026-05-15', count: 2, shade: 1 });
  });

  it('gives the darkest shade when the busiest day had a single upload', () => {
    const calendar = buildUsageCalendar(dto({ days: [{ date: '2026-02-02', reportsUploaded: 1 }] }));
    expect(cell(calendar, '2026-02-02')).toMatchObject({ kind: 'counted', shade: 4 });
  });

  it('totals each month from its days, and leaves months with no countable day empty (D9)', () => {
    const calendar = buildUsageCalendar(
      dto({
        firstDate: '2026-02-10',
        today: '2026-10-31',
        days: [
          { date: '2026-03-01', reportsUploaded: 3 },
          { date: '2026-03-31', reportsUploaded: 4 },
          { date: '2026-10-31', reportsUploaded: 1 },
        ],
      }),
    );
    expect(calendar.months.map((m) => m.reportsUploaded)).toEqual([null, 0, 7, 0, 0, 0, 0, 0, 0, 1, null, null]);
    expect(calendar.total).toBe(8);
    expect(calendar.busiest).toEqual({ date: '2026-03-31', count: 4 });
  });

  it('has no busiest day in a year without uploads', () => {
    expect(buildUsageCalendar(dto({})).busiest).toBeUndefined();
  });

  it('names a day without shifting it into the browser time zone', () => {
    expect(dayName('2026-05-14')).toBe('Thursday, 14 May 2026');
    expect(dayName('2027-01-01')).toBe('Friday, 1 January 2027');
  });

  it("offers every year from the organization's first to this one, newest first (D5)", () => {
    expect(calendarYears({ firstDate: '2024-06-01', today: '2026-10-31' })).toEqual([2026, 2025, 2024]);
    expect(calendarYears({ firstDate: '2026-10-31', today: '2026-10-31' })).toEqual([2026]);
  });
});
