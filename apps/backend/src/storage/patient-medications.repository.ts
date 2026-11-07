import { Injectable } from '@nestjs/common';
import type { PatientMedicationDto, PatientMedicationInput, PatientMedicationsQuery } from '@telesphoros/shared-types';
import { AppException } from '../common/app-exception';
export interface StoredMedication extends Omit<PatientMedicationDto, 'current'> {
  creationRequestHash: string;
}
export interface NewMedication {
  id: string;
  entryId: string;
  patientId: string;
  name: string;
  input: PatientMedicationInput;
  requestHash: string;
}
export abstract class PatientMedicationsRepository {
  abstract read(tenant: string, patient: string, query: PatientMedicationsQuery): Promise<PatientMedicationDto[]>;
  abstract findByRequest(tenant: string, actor: string, requestId: string): Promise<StoredMedication | undefined>;
  abstract insertVersion(tenant: string, actor: string, input: NewMedication): Promise<StoredMedication>;
}
export class MedicationRequestRaceError extends Error {}
export class MedicationStaleError extends Error {}
@Injectable()
export class UnavailablePatientMedicationsRepository extends PatientMedicationsRepository {
  async read(): Promise<PatientMedicationDto[]> {
    throw AppException.unavailable('Patient medications need the PostgreSQL store.');
  }
  async findByRequest(): Promise<StoredMedication | undefined> {
    throw AppException.unavailable('Patient medications need the PostgreSQL store.');
  }
  async insertVersion(): Promise<StoredMedication> {
    throw AppException.unavailable('Patient medications need the PostgreSQL store.');
  }
}

/** Explicit API boundary: retry fingerprints never leave persistence. */
export function medicationDto(record: StoredMedication, current: boolean): PatientMedicationDto {
  return {
    id: record.id,
    entryId: record.entryId,
    patientId: record.patientId,
    version: record.version,
    current,
    rxcui: record.rxcui,
    name: record.name,
    listVersion: record.listVersion,
    status: record.status,
    startMonth: record.startMonth,
    stopMonth: record.stopMonth,
    source: record.source,
    createdAt: record.createdAt,
    createdBy: record.createdBy,
  };
}
