import { Injectable } from '@nestjs/common';
import { byCreatedAt, type Page, type PageRequest, type ReportRecord, slicePage } from './records';

export interface ReportFilter {
  patientId?: string;
}

/** See PatientsRepository: every method is tenant-scoped. */
export abstract class ReportsRepository {
  abstract list(tenantId: string, page: PageRequest, filter: ReportFilter): Promise<Page<ReportRecord>>;
  abstract findById(tenantId: string, id: string): Promise<ReportRecord | undefined>;
  abstract countByPatient(tenantId: string, patientId: string): Promise<number>;
  abstract insert(record: ReportRecord): Promise<void>;
  abstract update(record: ReportRecord): Promise<void>;
  abstract delete(tenantId: string, id: string): Promise<boolean>;
}

@Injectable()
export class InMemoryReportsRepository extends ReportsRepository {
  private readonly rows = new Map<string, ReportRecord>();

  private owned(tenantId: string) {
    return [...this.rows.values()].filter((row) => row.tenantId === tenantId);
  }

  async list(tenantId: string, page: PageRequest, filter: ReportFilter) {
    const rows = this.owned(tenantId).filter((row) => !filter.patientId || row.patientId === filter.patientId);
    return slicePage(rows.sort(byCreatedAt), page);
  }
  async findById(tenantId: string, id: string) {
    const row = this.rows.get(id);
    return row && row.tenantId === tenantId ? { ...row } : undefined;
  }
  async countByPatient(tenantId: string, patientId: string) {
    return this.owned(tenantId).filter((row) => row.patientId === patientId).length;
  }
  async insert(record: ReportRecord) {
    this.rows.set(record.id, { ...record });
  }
  async update(record: ReportRecord) {
    this.rows.set(record.id, { ...record });
  }
  async delete(tenantId: string, id: string) {
    const row = this.rows.get(id);
    if (!row || row.tenantId !== tenantId) return false;
    return this.rows.delete(id);
  }
}
