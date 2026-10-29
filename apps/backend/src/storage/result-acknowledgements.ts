import type { AckKind, AckReviewTask } from '@telesphoros/shared-types';
import type { CdrBasis } from './clinician-decisions';

/** Result acknowledgements (spec 019 D02a): what the ledger repository takes and the refusals it can raise. Nothing was written when one is raised. */

export interface ResultAcknowledgementInput {
  resultId: string;
  /** The patient the client displayed the result for; compared with the result's own. */
  patientId: string;
  kind: AckKind;
  reviewTask: AckReviewTask;
  /** The basis the client displayed, in the order the server reports it (canonicalAckBasis). */
  displayedBasis: CdrBasis[];
  request: { id: string; hash: string };
}

export class ResultAcknowledgementNotFoundError extends Error {}
export class ResultAcknowledgementRequestReusedError extends Error {}
export class ResultAcknowledgementBindingError extends Error {}
export class ResultAcknowledgementBasisChangedError extends Error {}
export class ResultAcknowledgementDuplicateError extends Error {}
export class ResultAcknowledgementNotClinicianError extends Error {}
