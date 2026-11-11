import { describe, expect, it } from 'vitest';
import { exactAge, patientSummary } from './patientSummary';

describe('patientSummary', () => {
  it('joins what is recorded and leaves out what is not', () => {
    expect(patientSummary({ sex: 'female', birthYear: 1970 })).toBe('Female · born 1970');
    expect(patientSummary({ sex: null, birthYear: 1970 })).toBe('born 1970');
    expect(patientSummary({ sex: 'male', birthYear: null })).toBe('Male');
    expect(patientSummary({})).toBe('');
  });
});

describe('exactAge', () => {
  const on = (iso: string) => new Date(`${iso}T12:00:00`);
  it('counts the birthday itself and not the day before', () => {
    expect(exactAge('1970-11-10', on('2026-11-09'))).toBe(55);
    expect(exactAge('1970-11-10', on('2026-11-10'))).toBe(56);
    expect(exactAge('1970-01-01', on('2026-11-10'))).toBe(56);
    expect(exactAge('1970-12-31', on('2026-11-10'))).toBe(55);
  });
  it('handles a leap-day birthday', () => {
    expect(exactAge('1980-02-29', on('2026-02-28'))).toBe(45);
    expect(exactAge('1980-02-29', on('2026-03-01'))).toBe(46);
  });
  it('is null for a future or unusable date', () => {
    expect(exactAge('2030-01-01', on('2026-11-10'))).toBeNull();
    expect(exactAge('not-a-date', on('2026-11-10'))).toBeNull();
    expect(exactAge('1970-13-01', on('2026-11-10'))).toBeNull();
  });
});
