import { describe, expect, it } from 'vitest';
import { checkDraft, draftFrom, EMPTY_DRAFT, ETHNICITY_CODES, ETHNICITY_LABELS, incompleteness } from './demographicsDraft';

const FULL = {
  givenName: '  Zzyzx   Synthetic ',
  familyName: 'Núñez-Testcase',
  dateOfBirth: '1980-02-29',
  sex: 'female' as const,
  ethnicity: ['white' as const, 'asian' as const],
};

describe('checkDraft (spec 025 T301, D7)', () => {
  it('a blank draft is "no demographics yet" when optional, and every identity field is required when not', () => {
    expect(checkDraft(EMPTY_DRAFT, true)).toEqual({ input: null, errors: {} });
    const required = checkDraft(EMPTY_DRAFT, false);
    expect(required.input).toBeNull();
    expect(Object.keys(required.errors).sort()).toEqual(['dateOfBirth', 'familyName', 'givenName']);
  });

  it('accepts a full draft through the API schema: names normalized, ethnicity sorted, empty sex and ethnicity sent as null', () => {
    expect(checkDraft(FULL, true).input).toEqual({
      givenName: 'Zzyzx Synthetic',
      familyName: 'Núñez-Testcase',
      dateOfBirth: '1980-02-29',
      sex: 'female',
      ethnicity: ['asian', 'white'],
    });
    expect(checkDraft({ ...FULL, sex: '', ethnicity: [] }, false).input).toMatchObject({ sex: null, ethnicity: null });
  });

  it('once anything is typed, a partial draft is refused field by field (sex alone is not a version)', () => {
    expect(Object.keys(checkDraft({ ...EMPTY_DRAFT, sex: 'male' }, true).errors).sort()).toEqual(['dateOfBirth', 'familyName', 'givenName']);
    expect(checkDraft({ ...FULL, dateOfBirth: '2999-01-01' }, true).errors.dateOfBirth).toMatch(/future/);
    expect(checkDraft({ ...FULL, dateOfBirth: '1899-12-31' }, true).errors.dateOfBirth).toMatch(/1900-01-01/);
    expect(checkDraft({ ...FULL, givenName: 'x'.repeat(101) }, true).errors.givenName).toMatch(/100 characters/);
    expect(checkDraft({ ...FULL, familyName: 'a\u0007b' }, true).errors.familyName).toMatch(/printable/);
  });

  it('no message ever repeats what was typed', () => {
    const typed = ['Zzyzx-Needle-Given', 'Needle-Family\u0007', '1899-12-31'];
    const { errors } = checkDraft({ ...EMPTY_DRAFT, givenName: typed[0]!, familyName: typed[1]!, dateOfBirth: typed[2]! }, true);
    expect(Object.keys(errors).length).toBeGreaterThan(0);
    for (const message of Object.values(errors)) for (const value of typed) expect(message).not.toContain(value.replace('\u0007', ''));
  });
});

describe('labels and list state', () => {
  it('has a label for each of the seven 2024 codes, and nothing else', () => {
    expect(Object.keys(ETHNICITY_LABELS).sort()).toEqual([...ETHNICITY_CODES].sort());
    expect(ETHNICITY_CODES).toHaveLength(7);
  });

  it('reads Incomplete from the list field only; a row without it (a single patient, an older API) is unknown', () => {
    expect(incompleteness({ demographicsComplete: false })).toBe('incomplete');
    expect(incompleteness({ demographicsComplete: true })).toBe('complete');
    expect(incompleteness({})).toBe('unknown');
  });

  it('a correction starts from the version shown', () => {
    const draft = draftFrom({
      patientId: '0f8fad5b-d9cb-469f-a165-70867728950e',
      version: 2,
      current: true,
      givenName: 'A',
      familyName: 'B',
      dateOfBirth: '1990-01-31',
      sex: null,
      birthYear: 1990,
      ageYears: 36,
      ethnicity: null,
      createdAt: '2026-10-31T12:00:00.000Z',
      createdBy: 'person',
      versions: [],
    });
    expect(draft).toEqual({ givenName: 'A', familyName: 'B', dateOfBirth: '1990-01-31', sex: '', ethnicity: [] });
  });
});
