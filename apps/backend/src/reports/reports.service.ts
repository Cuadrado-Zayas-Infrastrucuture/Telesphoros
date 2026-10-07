import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { ReportCreate, ReportListQuery, ReportPatch } from '@telesphoros/shared-types';
import { AppException } from '../common/app-exception';
import type { Principal } from '../auth/principal';
import { PatientsRepository } from '../storage/patients.repository';
import type { ReportRecord } from '../storage/records';
import { ReportsRepository } from '../storage/reports.repository';

@Injectable()
export class ReportsService {
  constructor(
    private readonly reports: ReportsRepository,
    private readonly patients: PatientsRepository,
  ) {}

  list(principal: Principal, { page, pageSize, patientId }: ReportListQuery) {
    return this.reports.list(principal.sub, { offset: (page - 1) * pageSize, limit: pageSize }, { patientId });
  }

  async get(principal: Principal, id: string): Promise<ReportRecord> {
    const record = await this.reports.findById(principal.sub, id);
    if (!record) throw AppException.notFound('Report not found.');
    return record;
  }

  /** Registers report metadata for one of the caller's own patients. The new status is always "received". */
  async create(principal: Principal, input: ReportCreate): Promise<ReportRecord> {
    // Same NOT_FOUND whether the patient is missing or belongs to someone else.
    if (!(await this.patients.findById(principal.sub, input.patientId))) {
      throw AppException.notFound('Patient not found.');
    }
    const now = new Date().toISOString();
    const record: ReportRecord = {
      id: randomUUID(),
      ownerId: principal.sub,
      patientId: input.patientId,
      type: input.type,
      filename: input.filename,
      sizeBytes: input.sizeBytes,
      status: 'received',
      createdAt: now,
      updatedAt: now,
    };
    await this.reports.insert(record);
    return record;
  }

  async patch(principal: Principal, id: string, patch: ReportPatch): Promise<ReportRecord> {
    const existing = await this.get(principal, id);
    const updated: ReportRecord = {
      ...existing,
      ...(patch.type !== undefined ? { type: patch.type } : {}),
      ...(patch.filename !== undefined ? { filename: patch.filename } : {}),
      updatedAt: new Date().toISOString(),
    };
    await this.reports.update(updated);
    return updated;
  }

  async remove(principal: Principal, id: string): Promise<void> {
    await this.get(principal, id);
    await this.reports.delete(principal.sub, id);
  }
}
