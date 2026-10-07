import { Injectable } from '@nestjs/common';
import { byCreatedAt, type Page, type PageRequest, type PatientRecord, slicePage } from './records';

/**
 * Persistence contract. EVERY method takes `ownerId`, so a caller cannot even ask for another
 * owner's data. Each call is one lookup (no per-row follow-up queries).
 * Phase 3 provides a database-backed implementation of this same class.
 */
export abstract class PatientsRepository {
  abstract list(ownerId: string, page: PageRequest): Promise<Page<PatientRecord>>;
  abstract findById(ownerId: string, id: string): Promise<PatientRecord | undefined>;
  abstract findByLabel(ownerId: string, label: string): Promise<PatientRecord | undefined>;
  abstract insert(record: PatientRecord): Promise<void>;
  abstract update(record: PatientRecord): Promise<void>;
  abstract delete(ownerId: string, id: string): Promise<boolean>;
}

/** Development/test store. Data lives in process memory and is lost on restart. */
@Injectable()
export class InMemoryPatientsRepository extends PatientsRepository {
  private readonly rows = new Map<string, PatientRecord>();

  private owned(ownerId: string) {
    return [...this.rows.values()].filter((row) => row.ownerId === ownerId);
  }

  async list(ownerId: string, page: PageRequest) {
    return slicePage(this.owned(ownerId).sort(byCreatedAt), page);
  }
  async findById(ownerId: string, id: string) {
    const row = this.rows.get(id);
    return row && row.ownerId === ownerId ? { ...row } : undefined;
  }
  async findByLabel(ownerId: string, label: string) {
    const wanted = label.toLowerCase();
    return this.owned(ownerId).find((row) => row.label.toLowerCase() === wanted);
  }
  async insert(record: PatientRecord) {
    this.rows.set(record.id, { ...record });
  }
  async update(record: PatientRecord) {
    this.rows.set(record.id, { ...record });
  }
  async delete(ownerId: string, id: string) {
    const row = this.rows.get(id);
    if (!row || row.ownerId !== ownerId) return false;
    return this.rows.delete(id);
  }
}
