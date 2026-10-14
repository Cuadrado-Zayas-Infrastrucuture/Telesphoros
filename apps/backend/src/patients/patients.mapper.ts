import { type PatientDto, patientDtoSchema } from '@telesphoros/shared-types';
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
