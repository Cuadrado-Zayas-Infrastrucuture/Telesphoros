import { describe, expect, it } from 'vitest';
import { ageFromBirthYear, dateOfBirthProblem, ETHNICITY_CODES, patientDemographicsInputSchema, patientDtoSchema, SEX_CODES } from './index';

// Spec 025 PD-a: the request schema (T103). Each malformed field is refused on its own against a valid control, and no message repeats a submitted value.
describe('patientDemographicsInputSchema', () => {
  const valid = { givenName: 'Synthetic', familyName: 'Person', dateOfBirth: '1990-05-17', sex: 'female', ethnicity: ['white', 'asian'] };

  it('accepts a complete request and puts ethnicity in one fixed order', () => {
    const parsed = patientDemographicsInputSchema.parse(valid);
    expect(parsed).toEqual({ ...valid, ethnicity: ['asian', 'white'] });
  });

  it('keeps sex and ethnicity empty when left out or null, and has no other third code', () => {
    expect(patientDemographicsInputSchema.parse({ givenName: 'A', familyName: 'B', dateOfBirth: '1990-05-17' })).toMatchObject({ sex: null, ethnicity: null });
    expect(patientDemographicsInputSchema.parse({ ...valid, sex: null, ethnicity: null })).toMatchObject({ sex: null, ethnicity: null });
    expect([...SEX_CODES]).toEqual(['male', 'female']);
    expect(ETHNICITY_CODES).toHaveLength(7);
    for (const forbidden of ['unknown', 'declined', 'other', 'prefer-not-to-say']) {
      expect(ETHNICITY_CODES).not.toContain(forbidden);
      expect(SEX_CODES).not.toContain(forbidden);
    }
  });

  it('trims and collapses white space in names and normalizes to NFC', () => {
    const parsed = patientDemographicsInputSchema.parse({ ...valid, givenName: '  Ana   María ', familyName: 'Nüñez'.normalize('NFD') });
    expect(parsed.givenName).toBe('Ana María');
    expect(parsed.familyName).toBe(parsed.familyName.normalize('NFC'));
  });

  it.each([
    ['a missing given name', { givenName: undefined }],
    ['a blank family name', { familyName: ' \t ' }],
    ['a name over 100 characters', { givenName: 'x'.repeat(101) }],
    ['a name with a control character', { givenName: 'Syn\u0007thetic' }],
    ['a date written the American way', { dateOfBirth: '05/17/1990' }],
    ['a date without zero padding', { dateOfBirth: '1990-5-7' }],
    ['a date that does not exist', { dateOfBirth: '1990-02-30' }],
    ['a date before 1900', { dateOfBirth: '1899-12-31' }],
    ['a date in the future', { dateOfBirth: '2999-01-01' }],
    ['a date with a time', { dateOfBirth: '1990-05-17T00:00:00Z' }],
    ['a third sex code', { sex: 'unknown' }],
    ['an upper-case sex', { sex: 'Female' }],
    ['an ethnicity outside the list', { ethnicity: ['martian'] }],
    ['an empty ethnicity list', { ethnicity: [] }],
    ['a repeated ethnicity', { ethnicity: ['asian', 'asian'] }],
    ['a request id that is not a uuid', { requestId: 'abc' }],
    ['a birth year sent by the client', { birthYear: 1990 }],
    ['an unknown field', { tenantId: 'x' }],
  ])('refuses %s', (_label, change) => {
    expect(patientDemographicsInputSchema.safeParse({ ...valid, ...change }).success).toBe(false);
    expect(patientDemographicsInputSchema.safeParse(valid).success).toBe(true); // control
  });

  it('no validation message repeats the submitted value', () => {
    const marker = 'Zzyzx-Marker-1987-03-04';
    for (const change of [{ dateOfBirth: marker }, { givenName: `${marker}\u0007` }, { sex: marker }, { ethnicity: [marker] }, { dateOfBirth: `1987-02-30` }]) {
      const result = patientDemographicsInputSchema.safeParse({ ...valid, ...change });
      expect(result.success).toBe(false);
      if (!result.success) expect(JSON.stringify(result.error.issues)).not.toMatch(/Zzyzx|Marker|1987/);
    }
  });
});

describe('dateOfBirthProblem', () => {
  it('accepts the bounds and refuses just outside them, for a given "today"', () => {
    expect(dateOfBirthProblem('1900-01-01', '2026-10-30')).toBeNull();
    expect(dateOfBirthProblem('1899-12-31', '2026-10-30')).not.toBeNull();
    expect(dateOfBirthProblem('2026-10-30', '2026-10-30')).toBeNull();
    expect(dateOfBirthProblem('2026-10-31', '2026-10-30')).not.toBeNull();
    expect(dateOfBirthProblem('2000-02-29', '2026-10-30')).toBeNull(); // a leap day
    expect(dateOfBirthProblem('1900-02-29', '2026-10-30')).not.toBeNull(); // 1900 was not a leap year
  });
});

describe('ageFromBirthYear', () => {
  it('is this year minus the birth year (so it can be one year high before the birthday), and never negative', () => {
    expect(ageFromBirthYear(1990, new Date('2026-01-01T00:00:00Z'))).toBe(36);
    expect(ageFromBirthYear(1990, new Date('2026-12-31T23:59:59Z'))).toBe(36);
    expect(ageFromBirthYear(2030, new Date('2026-06-01T00:00:00Z'))).toBe(0);
  });
});

describe('patientDtoSchema with the coded list fields', () => {
  const base = { id: '0b0e9a3c-6f61-4d8e-9f1a-1c2d3e4f5a6b', label: 'SYN-1', createdAt: '2026-10-30T00:00:00.000Z', updatedAt: '2026-10-30T00:00:00.000Z' };

  it('still accepts the old shape, with no coded field added to it', () => {
    const parsed = patientDtoSchema.parse(base);
    expect(Object.keys(parsed).sort()).toEqual(['createdAt', 'id', 'label', 'mergedInto', 'updatedAt']);
  });

  it('accepts the coded list fields, and nothing that looks like an identity field', () => {
    const coded = { sex: 'male', birthYear: 1990, ageYears: 36, ethnicity: ['white'], demographicsComplete: true };
    expect(patientDtoSchema.parse({ ...base, ...coded })).toMatchObject(coded);
    for (const identity of [{ givenName: 'A' }, { familyName: 'B' }, { dateOfBirth: '1990-05-17' }]) {
      expect(patientDtoSchema.safeParse({ ...base, ...identity }).success).toBe(false);
    }
    expect(patientDtoSchema.safeParse({ ...base, sex: 'unknown' }).success).toBe(false);
  });
});
