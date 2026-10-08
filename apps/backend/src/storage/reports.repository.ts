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
  /** Changes only what a person may edit: type, file name, status. Never the stored file's identity. */
  abstract update(record: ReportRecord): Promise<void>;
  /**
   * Records the declared file (key, content type, hash) and, once, the first requester. Only while the report is not uploaded:
   * returns false if it already is, so a request that lost a race to `markUploaded` cannot rewrite an uploaded file's identity.
   */
  abstract recordUploadRequest(record: ReportRecord): Promise<boolean>;
  /** Marks the report uploaded, once, with the verified version and uploader. False means it was already uploaded (by someone else). */
  abstract markUploaded(record: ReportRecord): Promise<boolean>;
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
    const row = this.rows.get(record.id);
    if (!row) return;
    this.rows.set(record.id, { ...row, type: record.type, filename: record.filename, status: record.status, updatedAt: record.updatedAt });
  }
  async recordUploadRequest(record: ReportRecord) {
    const row = this.rows.get(record.id);
    if (!row || row.uploadedAt) return false;
    this.rows.set(record.id, {
      ...row, storageKey: record.storageKey, contentType: record.contentType, sha256: record.sha256,
      uploadRequestedBy: row.uploadRequestedBy ?? record.uploadRequestedBy ?? null, updatedAt: record.updatedAt,
    });
    return true;
  }
  async markUploaded(record: ReportRecord) {
    const row = this.rows.get(record.id);
    if (!row || row.uploadedAt) return false;
    this.rows.set(record.id, {
      ...row, uploadedAt: record.uploadedAt, objectVersion: record.objectVersion ?? null, uploadedBy: record.uploadedBy ?? null, updatedAt: record.updatedAt,
    });
    return true;
  }
  async delete(tenantId: string, id: string) {
    const row = this.rows.get(id);
    if (!row || row.tenantId !== tenantId) return false;
    return this.rows.delete(id);
  }
}
