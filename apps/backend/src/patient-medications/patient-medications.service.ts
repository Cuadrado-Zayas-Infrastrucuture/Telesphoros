import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { BUNDLED_DRUG_LIST, type DrugList, type PatientMedicationDto, type PatientMedicationInput, type PatientMedicationsQuery } from '@telesphoros/shared-types';
import type { Principal } from '../auth/principal';
import { AppException } from '../common/app-exception';
import { PatientsRepository } from '../storage/patients.repository';
import { medicationDto, MedicationRequestRaceError, MedicationStaleError, PatientMedicationsRepository } from '../storage/patient-medications.repository';
export const MEDICATION_DRUG_LIST = Symbol('MEDICATION_DRUG_LIST');
export const bundledMedicationList = () => BUNDLED_DRUG_LIST;
@Injectable()
export class PatientMedicationsService {
  constructor(
    private readonly patients: PatientsRepository,
    private readonly medications: PatientMedicationsRepository,
    @Inject(MEDICATION_DRUG_LIST) private readonly list: DrugList | null,
  ) {}
  async read(principal: Principal, patientId: string, query: PatientMedicationsQuery): Promise<{ items: PatientMedicationDto[] }> {
    await this.patient(principal, patientId);
    const items = await this.medications.read(principal.tenantId, patientId, query);
    if (query.entryId && !items.length) throw AppException.notFound('Medication entry or version not found.');
    return { items };
  }
  async record(principal: Principal, patientId: string, input: PatientMedicationInput): Promise<PatientMedicationDto> {
    await this.patient(principal, patientId);
    // Explicit stable order: retry equality cannot depend on the caller's JSON key order.
    const hash = createHash('sha256')
      .update(
        JSON.stringify([
          patientId,
          input.entryId ?? null,
          input.expectedVersion ?? null,
          input.rxcui,
          input.listVersion,
          input.status,
          input.startMonth,
          input.stopMonth,
          input.source,
        ]),
      )
      .digest('hex');
    const replay = async (): Promise<PatientMedicationDto | undefined> => {
      const prior = await this.medications.findByRequest(principal.tenantId, principal.sub, input.requestId);
      if (!prior) return undefined;
      if (prior.creationRequestHash !== hash || prior.patientId !== patientId)
        throw AppException.conflictBecause('request-id-reused', 'That request id was already used for different medication data.');
      const current = await this.medications.read(principal.tenantId, patientId, { entryId: prior.entryId });
      return medicationDto(prior, current[0]?.version === prior.version);
    };
    const prior = await replay();
    if (prior) return prior;
    if (!this.list) throw AppException.unavailable('The verified medication drug list is not installed.');
    if (input.listVersion !== this.list.version) throw AppException.conflictBecause('drug-list-changed', 'The drug list changed. Reload it before saving.');
    const drug = this.list.entries.find((entry) => entry.rxcui === input.rxcui);
    if (!drug) throw AppException.validation([{ field: 'rxcui', message: 'Choose a drug from the bundled list.' }]);
    try {
      const record = await this.medications.insertVersion(principal.tenantId, principal.sub, {
        id: randomUUID(),
        entryId: input.entryId ?? randomUUID(),
        patientId,
        name: drug.name,
        input,
        requestHash: hash,
      });
      return medicationDto(record, true);
    } catch (error) {
      if (error instanceof MedicationRequestRaceError || error instanceof MedicationStaleError) {
        const replayed = await replay();
        if (replayed) return replayed;
        if (error instanceof MedicationStaleError)
          throw AppException.conflictBecause('medication-changed', 'The medication entry changed. Read its current version before correcting it.');
        throw AppException.ledgerBusy();
      }
      throw error;
    }
  }
  private async patient(principal: Principal, patientId: string) {
    if (!(await this.patients.findById(principal.tenantId, patientId))) throw AppException.notFound('Patient not found.');
  }
}
