import { Injectable } from '@nestjs/common';
import { byCreatedAt, type Page, type PageRequest, type ReportRecord, slicePage } from './records';

export interface ReportFilter {
  patientId?: string;
}

/** See PatientsRepository: every method is owner-scoped. */
export abstract class ReportsRepository {
  abstract list(ownerId: string, page: PageRequest, filter: ReportFilter): Promise<Page<ReportRecord>>;
  abstract findById(ownerId: string, id: string): Promise<ReportRecord | undefined>;
  abstract countByPatient(ownerId: string, patientId: string): Promise<number>;
  abstract insert(record: ReportRecord): Promise<void>;
  abstract update(record: ReportRecord): Promise<void>;
  abstract delete(ownerId: string, id: string): Promise<boolean>;
}

@Injectable()
export class InMemoryReportsRepository extends ReportsRepository {
  private readonly rows = new Map<string, ReportRecord>();

  private owned(ownerId: string) {
    return [...this.rows.values()].filter((row) => row.ownerId === ownerId);
  }

  async list(ownerId: string, page: PageRequest, filter: ReportFilter) {
    const rows = this.owned(ownerId).filter((row) => !filter.patientId || row.patientId === filter.patientId);
    return slicePage(rows.sort(byCreatedAt), page);
  }
  async findById(ownerId: string, id: string) {
    const row = this.rows.get(id);
    return row && row.ownerId === ownerId ? { ...row } : undefined;
  }
  async countByPatient(ownerId: string, patientId: string) {
    return this.owned(ownerId).filter((row) => row.patientId === patientId).length;
  }
  async insert(record: ReportRecord) {
    this.rows.set(record.id, { ...record });
  }
  async update(record: ReportRecord) {
    this.rows.set(record.id, { ...record });
  }
  async delete(ownerId: string, id: string) {
    const row = this.rows.get(id);
    if (!row || row.ownerId !== ownerId) return false;
    return this.rows.delete(id);
  }
}
