import { describe, expect, it } from 'vitest';
import { formatBytes, formatCount, monthName } from './usage';

describe('usage formatting', () => {
  it('names a month from the API without shifting it into the browser time zone', () => {
    expect(monthName('2026-10')).toBe('October 2026');
    expect(monthName('2027-01')).toBe('January 2027');
    expect(monthName('2026-12')).toBe('December 2026');
  });

  it('groups counts with commas', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(12345)).toBe('12,345');
  });

  it('shows sizes in decimal units, with one decimal below 10', () => {
    expect(formatBytes(0)).toBe('0 bytes');
    expect(formatBytes(1)).toBe('1 byte');
    expect(formatBytes(999)).toBe('999 bytes');
    expect(formatBytes(1000)).toBe('1 kB');
    expect(formatBytes(1234)).toBe('1.2 kB');
    expect(formatBytes(10_485_760)).toBe('10 MB');
    expect(formatBytes(2_500_000_000)).toBe('2.5 GB');
  });
});
