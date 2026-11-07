import { puertoRicoDate, usageWindows, usageYear } from './usage-months';

const at = (iso: string) => usageWindows(new Date(iso)).map(({ month, from, to }) => ({ month, from: from.toISOString(), to: to.toISOString() }));

describe('usage months (Puerto Rico, UTC−4)', () => {
  it('turns over at 04:00 UTC on the first, not at midnight UTC', () => {
    expect(at('2026-11-01T03:59:59.999Z')[0]).toEqual({ month: '2026-10', from: '2026-10-01T04:00:00.000Z', to: '2026-11-01T04:00:00.000Z' });
    expect(at('2026-11-01T04:00:00.000Z')[0]).toEqual({ month: '2026-11', from: '2026-11-01T04:00:00.000Z', to: '2026-12-01T04:00:00.000Z' });
  });

  it('gives last month as the one before, across a year end', () => {
    expect(at('2027-01-15T12:00:00Z')).toEqual([
      { month: '2027-01', from: '2027-01-01T04:00:00.000Z', to: '2027-02-01T04:00:00.000Z' },
      { month: '2026-12', from: '2026-12-01T04:00:00.000Z', to: '2027-01-01T04:00:00.000Z' },
    ]);
  });

  it('includes the first instant of a month and excludes the first instant of the next', () => {
    const [current] = usageWindows(new Date('2026-03-01T04:00:00Z'));
    expect(current.month).toBe('2026-03');
    expect(current.to.getTime() - current.from.getTime()).toBe(31 * 86_400_000);
  });
});

describe('usage years and days (Puerto Rico, UTC−4, specs/028-usage-heatmap)', () => {
  const iso = ({ from, to }: { from: Date; to: Date }) => ({ from: from.toISOString(), to: to.toISOString() });

  it('runs a year from 1 January 04:00 UTC to the next 1 January 04:00 UTC', () => {
    expect(iso(usageYear(2026))).toEqual({ from: '2026-01-01T04:00:00.000Z', to: '2027-01-01T04:00:00.000Z' });
  });

  it('gives a leap year 366 days and a common year 365', () => {
    const days = (year: number) => (usageYear(year).to.getTime() - usageYear(year).from.getTime()) / 86_400_000;
    expect(days(2028)).toBe(366);
    expect(days(2026)).toBe(365);
  });

  it('turns the day over at 04:00 UTC, not at midnight UTC', () => {
    expect(puertoRicoDate(new Date('2026-10-31T03:59:59.999Z'))).toBe('2026-10-30');
    expect(puertoRicoDate(new Date('2026-10-31T04:00:00.000Z'))).toBe('2026-10-31');
  });

  it('puts 03:59 UTC on 1 January in the previous year', () => {
    expect(puertoRicoDate(new Date('2027-01-01T03:59:59.999Z'))).toBe('2026-12-31');
    expect(puertoRicoDate(usageYear(2027).from)).toBe('2027-01-01');
  });
});
