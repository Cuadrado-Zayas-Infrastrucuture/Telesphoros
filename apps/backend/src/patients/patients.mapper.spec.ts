import type { PatientRecord } from '../storage/records';
import { toPatientDto, toPatientListItemDto } from './patients.mapper';

const record = (over: Partial<PatientRecord> = {}): PatientRecord => ({
  id: '0b0e9a3c-6f61-4d8e-9f1a-1c2d3e4f5a6b',
  tenantId: 'syn-tenant',
  createdBy: 'syn-author',
  label: 'SYN-1',
  createdAt: '2026-10-30T00:00:00.000Z',
  updatedAt: '2026-10-30T00:00:00.000Z',
  ...over,
});
const NOW = new Date('2026-10-30T12:00:00Z');

describe('toPatientDto', () => {
  it('keeps the single-patient response exactly as it was: no coded field, even for a record that has them', () => {
    const dto = toPatientDto(record({ coded: { version: 1, sex: 'male', birthYear: 1990, ethnicity: ['white'] } }));
    expect(Object.keys(dto).sort()).toEqual(['createdAt', 'id', 'label', 'mergedInto', 'updatedAt']);
  });
});

describe('toPatientListItemDto', () => {
  it('derives the age from the birth year alone (this year minus the birth year) and reports completeness', () => {
    const dto = toPatientListItemDto(record({ coded: { version: 3, sex: 'female', birthYear: 1990, ethnicity: ['asian', 'white'] } }), NOW);
    expect(dto).toMatchObject({ sex: 'female', birthYear: 1990, ageYears: 36, ethnicity: ['asian', 'white'], demographicsComplete: true });
  });

  it('is incomplete when sex or ethnicity is empty, and null across the board with no demographics', () => {
    expect(toPatientListItemDto(record({ coded: { version: 1, sex: null, birthYear: 1990, ethnicity: ['white'] } }), NOW)).toMatchObject({
      sex: null,
      demographicsComplete: false,
    });
    expect(toPatientListItemDto(record({ coded: { version: 1, sex: 'male', birthYear: 1990, ethnicity: null } }), NOW)).toMatchObject({
      ethnicity: null,
      demographicsComplete: false,
    });
    expect(toPatientListItemDto(record(), NOW)).toMatchObject({ sex: null, birthYear: null, ageYears: null, ethnicity: null, demographicsComplete: false });
  });

  it('lists exactly the public fields plus the five coded ones, and nothing from the record that is internal', () => {
    const dto = toPatientListItemDto(record({ creationRequestId: 'x', creationRequestHash: 'y', coded: { version: 1, sex: 'male', birthYear: 1990, ethnicity: null } }), NOW);
    expect(Object.keys(dto).sort()).toEqual(['ageYears', 'birthYear', 'createdAt', 'demographicsComplete', 'ethnicity', 'id', 'label', 'mergedInto', 'sex', 'updatedAt']);
  });
});
