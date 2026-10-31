import { createHash, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { PatientCreate, PatientInput, PatientListQuery } from '@telesphoros/shared-types';
import { AppException } from '../common/app-exception';
import type { Principal } from '../auth/principal';
import { IntegrityError, PatientHasMergedRecordsError } from '../storage/errors';
import { PatientDemographicsRepository } from '../storage/patient-demographics.repository';
import { PatientsRepository } from '../storage/patients.repository';
import type { PatientRecord } from '../storage/records';
import { ReportsRepository } from '../storage/reports.repository';

@Injectable()
export class PatientsService {
  constructor(
    private readonly patients: PatientsRepository,
    private readonly reports: ReportsRepository,
    // Coded columns only. This service is deliberately NOT given the key provider: a list cannot decrypt anything (spec 025, PD-6).
    private readonly demographics: PatientDemographicsRepository,
  ) {}

  async list(principal: Principal, { page, pageSize, includeMerged }: Pick<PatientListQuery, 'page' | 'pageSize'> & { includeMerged?: boolean }) {
    const result = await this.patients.list(principal.tenantId, { offset: (page - 1) * pageSize, limit: pageSize }, { includeMerged });
    return { ...result, items: await this.withCoded(principal.tenantId, result.items) };
  }

  /** Attaches each patient's latest coded demographics (sex, birth year, ethnicity). Reads no ciphertext and needs no key. */
  async withCoded(tenantId: string, records: PatientRecord[]): Promise<PatientRecord[]> {
    const coded = await this.demographics.codedFor(
      tenantId,
      records.map((r) => r.id),
    );
    return records.map((r) => (coded.has(r.id) ? { ...r, coded: coded.get(r.id)! } : r));
  }

  /** Someone else's patient is reported as NOT_FOUND, so ids cannot be probed for existence. */
  async get(principal: Principal, id: string): Promise<PatientRecord> {
    const record = await this.patients.findById(principal.tenantId, id);
    if (!record) throw AppException.notFound('Patient not found.');
    return record;
  }

  async create(principal: Principal, input: PatientCreate): Promise<PatientRecord> {
    const requestId = input.requestId;
    // The hash is of the original request alone, so a later label change cannot make a repeat look like a different request.
    const requestHash = requestId
      ? createHash('sha256')
          .update(JSON.stringify([input.label]))
          .digest('hex')
      : undefined;
    if (requestId) {
      // A repeat of a create that succeeded must not meet the label it created.
      const prior = await this.patients.findByRequest(principal.tenantId, principal.sub, requestId);
      if (prior) {
        if (prior.creationRequestHash !== requestHash) throw AppException.conflictBecause('request-id-reused', 'That request id was already used for a different patient.');
        const live = await this.patients.findById(principal.tenantId, prior.id);
        if (!live) throw AppException.conflictBecause('request-id-reused', 'That request id was used for a patient that has since been deleted.');
        return live;
      }
    }
    await this.assertLabelFree(principal.tenantId, input.label);
    const now = new Date().toISOString();
    const record: PatientRecord = {
      id: randomUUID(),
      tenantId: principal.tenantId,
      createdBy: principal.sub,
      label: input.label,
      createdAt: now,
      updatedAt: now,
      ...(requestId ? { creationRequestId: requestId, creationRequestHash: requestHash! } : {}),
    };
    if (!requestId) {
      await this.patients.insert(record);
      return record;
    }
    try {
      return await this.patients.insertOrReplay(record);
    } catch (error) {
      // A concurrent repeat with another body, or a label taken in the meantime: both are conflicts, and the id says which only to the one who set it.
      if (error instanceof IntegrityError) throw AppException.conflict('A patient with that label already exists, or that request id was used for a different patient.');
      throw error;
    }
  }

  async replace(principal: Principal, id: string, input: PatientInput): Promise<PatientRecord> {
    const existing = await this.get(principal, id);
    await this.assertLabelFree(principal.tenantId, input.label, existing.id);
    const updated = { ...existing, label: input.label, updatedAt: new Date().toISOString() };
    await this.patients.update(updated);
    return updated;
  }

  /** Mirrors the Phase 3 foreign key: a patient with reports cannot be deleted (ON DELETE RESTRICT). */
  async remove(principal: Principal, id: string): Promise<void> {
    await this.get(principal, id);
    if ((await this.reports.countByPatient(principal.tenantId, id)) > 0) {
      throw AppException.conflict('This patient still has reports. Delete them first.');
    }
    // Deleting the patient another record was merged into would leave that record hidden behind a patient that is gone, and the merge could not be undone.
    if (await this.patients.hasMergedRecords(principal.tenantId, id)) {
      throw AppException.conflictBecause('patient-has-merged-records', 'Other patient records were merged into this one. Unmerge them first.');
    }
    try {
      await this.patients.delete(principal.tenantId, id, principal.sub);
    } catch (error) {
      // A merge landed after the check above; the database refuses the delete and the answer is the same.
      if (error instanceof PatientHasMergedRecordsError)
        throw AppException.conflictBecause('patient-has-merged-records', 'Other patient records were merged into this one. Unmerge them first.');
      throw error;
    }
  }

  private async assertLabelFree(tenantId: string, label: string, ignoreId?: string) {
    const clash = await this.patients.findByLabel(tenantId, label);
    if (clash && clash.id !== ignoreId) throw AppException.conflict('A patient with that label already exists.');
  }
}
