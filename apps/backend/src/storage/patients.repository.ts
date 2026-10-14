import { Injectable } from '@nestjs/common';
import { byCreatedAt, type Page, type PageRequest, type PatientRecord, slicePage } from './records';

/**
 * Persistence contract. EVERY method takes `tenantId`, so a caller cannot even ask for another
 * tenant's data. Each call is one lookup (no per-row follow-up queries).
 * Phase 3 provides a database-backed implementation of this same class.
 */
export abstract class PatientsRepository {
  /** Merged-away patients (M2.1c-2) are left out unless `includeMerged`; each record says what it was merged into. */
  abstract list(tenantId: string, page: PageRequest, options?: { includeMerged?: boolean }): Promise<Page<PatientRecord>>;
  abstract findById(tenantId: string, id: string): Promise<PatientRecord | undefined>;
  abstract findByLabel(tenantId: string, label: string): Promise<PatientRecord | undefined>;
  abstract insert(record: PatientRecord): Promise<void>;
  abstract update(record: PatientRecord): Promise<void>;
  abstract delete(tenantId: string, id: string): Promise<boolean>;
}

/** Development/test store. Data lives in process memory and is lost on restart. */
@Injectable()
export class InMemoryPatientsRepository extends PatientsRepository {
  private readonly rows = new Map<string, PatientRecord>();

  private owned(tenantId: string) {
    return [...this.rows.values()].filter((row) => row.tenantId === tenantId);
  }

  async list(tenantId: string, page: PageRequest) {
    return slicePage(this.owned(tenantId).sort(byCreatedAt), page);
  }
  async findById(tenantId: string, id: string) {
    const row = this.rows.get(id);
    return row && row.tenantId === tenantId ? { ...row } : undefined;
  }
  async findByLabel(tenantId: string, label: string) {
    const wanted = label.toLowerCase();
    return this.owned(tenantId).find((row) => row.label.toLowerCase() === wanted);
  }
  async insert(record: PatientRecord) {
    this.rows.set(record.id, { ...record });
  }
  async update(record: PatientRecord) {
    this.rows.set(record.id, { ...record });
  }
  async delete(tenantId: string, id: string) {
    const row = this.rows.get(id);
    if (!row || row.tenantId !== tenantId) return false;
    return this.rows.delete(id);
  }
}
