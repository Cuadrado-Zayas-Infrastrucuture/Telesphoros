import { ageFromBirthYear, type PatientDto, patientDtoSchema } from '@telesphoros/shared-types';
import type { PatientRecord } from '../storage/records';

/** Explicit field list + schema check: an internal field can never reach a response by accident. */
export function toPatientDto(record: PatientRecord): PatientDto {
  return patientDtoSchema.parse({
    id: record.id,
    label: record.label,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    mergedInto: record.mergedInto ?? null,
  });
}

/**
 * A list item: the patient, plus the coded demographics (spec 025, PD-6). Every field named here is a coded column or derived from one; no identity value
 * is read, and nothing here has the means to decrypt. `ageYears` is this year minus the birth year, so it can be one year high until the birthday.
 */
export function toPatientListItemDto(record: PatientRecord, now: Date = new Date()): PatientDto {
  const coded = record.coded;
  return patientDtoSchema.parse({
    ...toPatientDto(record),
    sex: coded?.sex ?? null,
    birthYear: coded?.birthYear ?? null,
    ageYears: coded ? ageFromBirthYear(coded.birthYear, now) : null,
    ethnicity: coded?.ethnicity ?? null,
    demographicsComplete: coded !== undefined && coded.sex !== null && coded.ethnicity !== null,
  });
}
