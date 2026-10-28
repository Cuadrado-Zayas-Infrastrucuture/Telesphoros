import { usageWindows } from './usage-months';

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
