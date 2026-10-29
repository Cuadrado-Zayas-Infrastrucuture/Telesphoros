import type { CdrEntryKind, CdrResponse } from '@telesphoros/shared-types';

/** Clinician result decisions (spec 006 D01b): what the ledger repository takes and the refusals it can raise. Nothing was written when one is raised. */

export interface ClinicianDecisionInput {
  resultId: string;
  evaluationId: string;
  patientId: string;
  entryKind: CdrEntryKind;
  previousEntryId: string | null;
  response: CdrResponse | null;
  detailCodes: string[];
  reviewBy: string | null;
  note?: string;
  /** Normalised to UTC; absent means "now" (the database sets it to the recorded time). */
  occurredAt?: string;
  request: { id: string; hash: string };
}

export type CdrBasis = 'active' | 'retracted' | 'superseded' | 'quarantined' | 'disputed' | 'not-current';

export interface ResultBasis {
  resultId: string;
  evaluationId: string;
  patientId: string;
  basis: CdrBasis[];
  /** The basis rule (`cdr-eligibility-v1`) allows a new entry: the basis is `active` and the result is not held. */
  eligible: boolean;
}

export class ClinicianDecisionNotFoundError extends Error {}
export class ClinicianDecisionRequestReusedError extends Error {}
export class ClinicianDecisionBindingError extends Error {}
export class ClinicianDecisionStaleError extends Error {}
export class ClinicianDecisionNotAuthorError extends Error {}
export class ClinicianDecisionNotClinicianError extends Error {}
export class ClinicianDecisionBasisError extends Error {}
export class ClinicianDecisionRuleError extends Error {
  constructor(readonly field: string) {
    super('A clinician decision rule was broken.');
  }
}
