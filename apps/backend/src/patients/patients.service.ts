import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { PatientInput, PatientListQuery } from '@telesphoros/shared-types';
import { AppException } from '../common/app-exception';
import type { Principal } from '../auth/principal';
import { PatientsRepository } from '../storage/patients.repository';
import type { PatientRecord } from '../storage/records';
import { ReportsRepository } from '../storage/reports.repository';

@Injectable()
export class PatientsService {
  constructor(
    private readonly patients: PatientsRepository,
    private readonly reports: ReportsRepository,
  ) {}

  list(principal: Principal, { page, pageSize, includeMerged }: Pick<PatientListQuery, 'page' | 'pageSize'> & { includeMerged?: boolean }) {
    return this.patients.list(principal.tenantId, { offset: (page - 1) * pageSize, limit: pageSize }, { includeMerged });
  }

  /** Someone else's patient is reported as NOT_FOUND, so ids cannot be probed for existence. */
  async get(principal: Principal, id: string): Promise<PatientRecord> {
    const record = await this.patients.findById(principal.tenantId, id);
    if (!record) throw AppException.notFound('Patient not found.');
    return record;
  }

  async create(principal: Principal, input: PatientInput): Promise<PatientRecord> {
    await this.assertLabelFree(principal.tenantId, input.label);
    const now = new Date().toISOString();
    const record: PatientRecord = {
      id: randomUUID(),
      tenantId: principal.tenantId,
      createdBy: principal.sub,
      label: input.label,
      createdAt: now,
      updatedAt: now,
    };
    await this.patients.insert(record);
    return record;
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
    await this.patients.delete(principal.tenantId, id);
  }

  private async assertLabelFree(tenantId: string, label: string, ignoreId?: string) {
    const clash = await this.patients.findByLabel(tenantId, label);
    if (clash && clash.id !== ignoreId) throw AppException.conflict('A patient with that label already exists.');
  }
}
