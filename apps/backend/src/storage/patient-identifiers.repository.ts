import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { PatientsRepository } from './patients.repository';
import { type Page, type PageRequest, slicePage } from './records';

/** An identifier a clinic uses for a patient, as stored: a keyed digest, never the value. */
export interface IdentifierRecord {
  id: string;
  tenantId: string;
  patientId: string;
  system: string;
  /** The keyed digest. Sensitive: it never leaves the API (no DTO carries it). */
  digest: Buffer;
  keyVersion: number;
  status: 'active' | 'withdrawn';
  createdBy: string;
  createdAt: Date;
  withdrawnAt: Date | null;
}

/** Two patients of an organization whose identifiers collided: a possible duplicate. Holds no number and no digest, only the assigning system. */
export interface DuplicateCandidate {
  patientId: string;
  patientLabel: string;
  otherPatientId: string;
  otherPatientLabel: string;
  system: string;
  flaggedAt: Date;
}

/** Another patient of the organization already holds this number under this system. The message never says which. */
export class IdentifierInUseError extends Error {
  constructor() {
    super('That identifier is already registered to a patient of this organization.');
    this.name = 'IdentifierInUseError';
  }
}

/** The retry id of a registration was already used for a different original request. */
export class IdentifierRequestReusedError extends Error {
  constructor() {
    super('That request id was already used for a different identifier.');
    this.name = 'IdentifierRequestReusedError';
  }
}

/** The retry identity of a registration: set by the caller, kept with the row, never shown. `hash` fingerprints the original request. */
export interface RegistrationRequest {
  id: string;
  hash: string;
}

/** See PatientsRepository: every method is tenant-scoped. Only the digest is stored; the value never reaches this layer. */
export abstract class PatientIdentifiersRepository {
  /**
   * Throws IdentifierInUseError when an active identifier already holds the same system and digest. When that holder is ANOTHER patient, the
   * collision also leaves a possible-duplicate flag (one per unordered pair) before the error is thrown; no number or digest is kept in it.
   */
  /**
   * Registers an identifier. With `request`, a repeat by the same person with the same fingerprint returns the identifier already stored under it (also after it was
   * withdrawn) and a different fingerprint throws `IdentifierRequestReusedError`; a number another patient holds still throws `IdentifierInUseError`.
   */
  abstract add(
    tenantId: string,
    actor: string,
    input: { patientId: string; system: string; digest: Buffer; keyVersion: number; request?: RegistrationRequest },
  ): Promise<IdentifierRecord>;
  /** Every identifier of the patient, oldest first, withdrawn ones included. */
  abstract list(tenantId: string, patientId: string): Promise<IdentifierRecord[]>;
  /** False when there is no such active identifier on that patient. */
  abstract withdraw(tenantId: string, actor: string, patientId: string, identifierId: string): Promise<boolean>;
  /**
   * The active identifier with this system and digest held by THIS patient or, when merges exist, by any patient of its group (a root and its
   * aliases), if any. Without merges the group is the patient alone.
   */
  abstract findActiveOfPatient(tenantId: string, patientId: string, system: string, digest: Buffer): Promise<IdentifierRecord | undefined>;
  /**
   * The possible duplicates to review, newest first: pairs whose identifiers collided, leaving out a pair whose merge was declined (the pair is
   * dismissed), a pair that is already one group, and a pair with a deleted patient.
   */
  abstract listDuplicates(tenantId: string, page: PageRequest): Promise<Page<DuplicateCandidate>>;
}

@Injectable()
export class InMemoryPatientIdentifiersRepository extends PatientIdentifiersRepository {
  private readonly rows: IdentifierRecord[] = [];
  private readonly requests = new Map<string, { hash: string; record: IdentifierRecord }>();
  private readonly flags: { tenantId: string; patientId: string; otherPatientId: string; system: string; flaggedAt: Date }[] = [];

  constructor(private readonly patients: PatientsRepository) {
    super();
  }

  async add(
    tenantId: string,
    actor: string,
    input: { patientId: string; system: string; digest: Buffer; keyVersion: number; request?: RegistrationRequest },
  ): Promise<IdentifierRecord> {
    if (input.request) {
      const prior = this.requests.get(`${tenantId}\u0000${actor}\u0000${input.request.id}`);
      if (prior) {
        if (prior.hash !== input.request.hash) throw new IdentifierRequestReusedError();
        return { ...prior.record };
      }
    }
    // An identifier of a patient that was deleted is not held (PostgreSQL withdraws it when the patient is deleted; here the patient lookup stands in for that).
    const live = new Map<string, boolean>();
    for (const r of this.rows) if (!live.has(r.patientId)) live.set(r.patientId, (await this.patients.findById(r.tenantId, r.patientId)) !== undefined);
    const holder = this.rows.find((r) => r.tenantId === tenantId && r.status === 'active' && r.system === input.system && r.digest.equals(input.digest) && live.get(r.patientId));
    if (holder) {
      if (holder.patientId !== input.patientId) {
        const [patientId, otherPatientId] = [holder.patientId, input.patientId].sort();
        if (!this.flags.some((f) => f.tenantId === tenantId && f.patientId === patientId && f.otherPatientId === otherPatientId)) {
          this.flags.push({ tenantId, patientId: patientId!, otherPatientId: otherPatientId!, system: input.system, flaggedAt: new Date() });
        }
      }
      throw new IdentifierInUseError();
    }
    const record: IdentifierRecord = {
      id: randomUUID(),
      tenantId,
      patientId: input.patientId,
      system: input.system,
      digest: Buffer.from(input.digest),
      keyVersion: input.keyVersion,
      status: 'active',
      createdBy: actor,
      createdAt: new Date(),
      withdrawnAt: null,
    };
    this.rows.push(record);
    // The stored row is shared by reference, so a later withdrawal shows in a replay (as on PostgreSQL).
    if (input.request) this.requests.set(`${tenantId}\u0000${actor}\u0000${input.request.id}`, { hash: input.request.hash, record });
    return { ...record };
  }

  async list(tenantId: string, patientId: string): Promise<IdentifierRecord[]> {
    return this.rows.filter((r) => r.tenantId === tenantId && r.patientId === patientId).map((r) => ({ ...r }));
  }

  async withdraw(tenantId: string, _actor: string, patientId: string, identifierId: string): Promise<boolean> {
    const row = this.rows.find((r) => r.tenantId === tenantId && r.patientId === patientId && r.id === identifierId && r.status === 'active');
    if (!row) return false;
    row.status = 'withdrawn';
    row.withdrawnAt = new Date();
    return true;
  }

  async findActiveOfPatient(tenantId: string, patientId: string, system: string, digest: Buffer): Promise<IdentifierRecord | undefined> {
    const row = this.rows.find((r) => r.tenantId === tenantId && r.patientId === patientId && r.status === 'active' && r.system === system && r.digest.equals(digest));
    return row ? { ...row } : undefined;
  }

  async listDuplicates(tenantId: string, page: PageRequest): Promise<Page<DuplicateCandidate>> {
    // Merges are a ledger record and exist only on PostgreSQL, so here nothing is dismissed and no pair is already one group.
    const candidates: DuplicateCandidate[] = [];
    for (const f of this.flags.filter((x) => x.tenantId === tenantId).reverse()) {
      const [a, b] = await Promise.all([this.patients.findById(tenantId, f.patientId), this.patients.findById(tenantId, f.otherPatientId)]);
      if (a && b) candidates.push({ patientId: a.id, patientLabel: a.label, otherPatientId: b.id, otherPatientLabel: b.label, system: f.system, flaggedAt: f.flaggedAt });
    }
    return slicePage(candidates, page);
  }
}
