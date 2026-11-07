import { Injectable } from '@nestjs/common';
import type { DemographicsCompleteness, EthnicityCode, SexCode } from '@telesphoros/shared-types';
import { AppException } from '../common/app-exception';
import type { SealedField } from '../patient-demographics/identity-crypto';

/**
 * Persistence of patient demographics (spec 025, PD-a). The repository stores and returns CIPHERTEXT: it never holds a data key and never decrypts, so a
 * method here cannot leak an identity value. The service (patient-demographics.service.ts) owns the keys.
 *
 * Every method takes `tenantId`. There is deliberately no in-memory version: the records are ledgered, and the ledger exists only on PostgreSQL.
 */

/** The coded columns a list carries. Nothing here is an identity value. */
export interface CodedDemographics {
  version: number;
  sex: SexCode | null;
  birthYear: number;
  ethnicity: EthnicityCode[] | null;
}

/** One stored version, identity still sealed. */
export interface StoredDemographics extends CodedDemographics {
  id: string;
  patientId: string;
  keyVersion: number;
  givenName: SealedField;
  familyName: SealedField;
  dateOfBirth: SealedField;
  createdAt: string;
  createdBy: string;
  /** The keyed fingerprint of the request that created it, when it carried a retry id. */
  creationRequestHash: string | null;
}

export interface StoredFieldKey {
  keyVersion: number;
  wrapped: Buffer;
  provider: string;
}

/** What is stored for a patient: the key (absent after an erasure, or before the first version) and whether any version exists. */
export interface KeyState {
  key?: StoredFieldKey;
  hasVersions: boolean;
}

export interface NewDemographics {
  id: string;
  patientId: string;
  keyVersion: number;
  givenName: SealedField;
  familyName: SealedField;
  dateOfBirth: SealedField;
  sex: SexCode | null;
  birthYear: number;
  ethnicity: EthnicityCode[] | null;
  request?: { id: string; hash: string };
  /** Set for the patient's first version: the wrapped key is stored in the same transaction as the version it protects. */
  newKey?: { keyVersion: number; wrapped: Buffer; provider: string };
}

/** The patient's key is gone (an erasure, D8), or the database refused to store a version without one. Nothing was saved. */
export class IdentityErasedError extends Error {
  constructor() {
    super('The identity of this patient has been erased.');
    this.name = 'IdentityErasedError';
  }
}

/** Another request created the patient's key between our look-up and our insert. Nothing was saved; read the key state again. */
export class FieldKeyRaceError extends Error {
  constructor() {
    super('The patient key was created by another request.');
    this.name = 'FieldKeyRaceError';
  }
}

/** The same retry id was stored by a concurrent request. Nothing was saved; look the request up again. */
export class DemographicsRequestRaceError extends Error {
  constructor() {
    super('The request id was stored by another request.');
    this.name = 'DemographicsRequestRaceError';
  }
}

export abstract class PatientDemographicsRepository {
  /** The latest version's coded columns for each patient that has one. Reads no ciphertext, so no key is needed and none is used. */
  abstract codedFor(tenantId: string, patientIds: readonly string[]): Promise<Map<string, CodedDemographics>>;
  /** One count per completeness state over the organization's live patients, from the latest version's coded columns. Reads no ciphertext and needs no key. */
  abstract completenessCounts(tenantId: string): Promise<DemographicsCompleteness>;
  abstract keyState(tenantId: string, patientId: string): Promise<KeyState>;
  /** Every version of the patient, oldest first, identity sealed. */
  abstract versions(tenantId: string, patientId: string): Promise<StoredDemographics[]>;
  /** The version this person stored under this retry id, if any. */
  abstract findByRequest(tenantId: string, actor: string, requestId: string): Promise<StoredDemographics | undefined>;
  /** Stores one version (and the key, for the first) and its ledger event in one transaction. Throws IdentityErasedError, FieldKeyRaceError or DemographicsRequestRaceError. */
  abstract insertVersion(tenantId: string, actor: string, input: NewDemographics): Promise<StoredDemographics>;
}

/** The in-memory store has no demographics: lists show none, and the routes answer 503 (the ledger exists only on PostgreSQL). */
@Injectable()
export class UnavailablePatientDemographicsRepository extends PatientDemographicsRepository {
  async codedFor(): Promise<Map<string, CodedDemographics>> {
    return new Map();
  }
  async completenessCounts(): Promise<DemographicsCompleteness> {
    throw this.unavailable();
  }
  async keyState(): Promise<KeyState> {
    throw this.unavailable();
  }
  async versions(): Promise<StoredDemographics[]> {
    throw this.unavailable();
  }
  async findByRequest(): Promise<StoredDemographics | undefined> {
    throw this.unavailable();
  }
  async insertVersion(): Promise<StoredDemographics> {
    throw this.unavailable();
  }
  private unavailable() {
    return AppException.unavailable('Patient demographics need the PostgreSQL store.');
  }
}
