import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';

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

/** Another patient of the organization already holds this number under this system. The message never says which. */
export class IdentifierInUseError extends Error {
  constructor() {
    super('That identifier is already registered to a patient of this organization.');
    this.name = 'IdentifierInUseError';
  }
}

/** See PatientsRepository: every method is tenant-scoped. Only the digest is stored; the value never reaches this layer. */
export abstract class PatientIdentifiersRepository {
  /** Throws IdentifierInUseError when an active identifier already holds the same system and digest. */
  abstract add(tenantId: string, actor: string, input: { patientId: string; system: string; digest: Buffer; keyVersion: number }): Promise<IdentifierRecord>;
  /** Every identifier of the patient, oldest first, withdrawn ones included. */
  abstract list(tenantId: string, patientId: string): Promise<IdentifierRecord[]>;
  /** False when there is no such active identifier on that patient. */
  abstract withdraw(tenantId: string, actor: string, patientId: string, identifierId: string): Promise<boolean>;
  /** The active identifier of THIS patient with this system and digest, if any. */
  abstract findActiveOfPatient(tenantId: string, patientId: string, system: string, digest: Buffer): Promise<IdentifierRecord | undefined>;
}

@Injectable()
export class InMemoryPatientIdentifiersRepository extends PatientIdentifiersRepository {
  private readonly rows: IdentifierRecord[] = [];

  async add(tenantId: string, actor: string, input: { patientId: string; system: string; digest: Buffer; keyVersion: number }): Promise<IdentifierRecord> {
    if (this.rows.some((r) => r.tenantId === tenantId && r.status === 'active' && r.system === input.system && r.digest.equals(input.digest))) throw new IdentifierInUseError();
    const record: IdentifierRecord = {
      id: randomUUID(), tenantId, patientId: input.patientId, system: input.system, digest: Buffer.from(input.digest), keyVersion: input.keyVersion,
      status: 'active', createdBy: actor, createdAt: new Date(), withdrawnAt: null,
    };
    this.rows.push(record);
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
}
