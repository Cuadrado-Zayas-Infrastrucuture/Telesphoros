import { Injectable } from '@nestjs/common';
import { IntegrityError } from './errors';
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
  /**
   * Stores a patient that carries a retry identity, or returns the one already stored under it by the same creator. Throws `IntegrityError` when the
   * identity belongs to a different original request or to a deleted patient, or when the label is taken. Race-safe on PostgreSQL.
   */
  abstract insertOrReplay(record: PatientRecord): Promise<PatientRecord>;
  /** The patient this person created under that retry id (deleted or not), with the hash of its original request. */
  abstract findByRequest(tenantId: string, createdBy: string, requestId: string): Promise<PatientRecord | undefined>;
  abstract update(record: PatientRecord): Promise<void>;
  /** Soft-deletes the patient. Its active identifiers are withdrawn by `actor` in the same step: a deleted patient holds no identifier. False when there was nothing to delete. */
  abstract delete(tenantId: string, id: string, actor: string): Promise<boolean>;
  /** True while another patient's record is merged into this one (an approved merge in force). Merges exist only on PostgreSQL; elsewhere this is false. */
  abstract hasMergedRecords(tenantId: string, id: string): Promise<boolean>;
}

/** Development/test store. Data lives in process memory and is lost on restart. */
@Injectable()
export class InMemoryPatientsRepository extends PatientsRepository {
  private readonly rows = new Map<string, PatientRecord>();
  /** Deleted patients, kept only for their retry identity: a retry of a create whose patient was deleted is refused, as on PostgreSQL. */
  private readonly tombstones = new Map<string, PatientRecord>();

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
  async insertOrReplay(record: PatientRecord) {
    const prior = await this.findByRequest(record.tenantId, record.createdBy, record.creationRequestId!);
    if (prior) {
      if (this.tombstones.has(prior.id) || prior.creationRequestHash !== record.creationRequestHash) throw new IntegrityError('patients_creation_request_uq');
      return prior;
    }
    if (await this.findByLabel(record.tenantId, record.label)) throw new IntegrityError('patients_owner_label_uq');
    this.rows.set(record.id, { ...record });
    return { ...record };
  }
  async findByRequest(tenantId: string, createdBy: string, requestId: string) {
    const row = [...this.rows.values(), ...this.tombstones.values()].find((r) => r.tenantId === tenantId && r.createdBy === createdBy && r.creationRequestId === requestId);
    return row ? { ...row } : undefined;
  }
  async update(record: PatientRecord) {
    this.rows.set(record.id, { ...record });
  }
  // The identifiers sit in InMemoryPatientIdentifiersRepository, which treats a missing patient's identifiers as not held.
  async delete(tenantId: string, id: string) {
    const row = this.rows.get(id);
    if (!row || row.tenantId !== tenantId) return false;
    if (row.creationRequestId) this.tombstones.set(id, row);
    return this.rows.delete(id);
  }
  async hasMergedRecords() {
    return false; // a merge is a ledger record, and the ledger exists only on PostgreSQL
  }
}
