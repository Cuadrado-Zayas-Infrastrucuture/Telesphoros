import { Injectable, Optional } from '@nestjs/common';
import { ACK_REFUSAL_REASONS, type ResultAcknowledgementCreate, type ResultAcknowledgementDto, type ResultAcknowledgementsDto, sameAckBasis } from '@telesphoros/shared-types';
import { AppException } from '../common/app-exception';
import type { Principal } from '../auth/principal';
import type { Projected } from '../storage/ledger-records';
import { canonicalHash } from '../services/report-adapter/canonical-json';
import {
  ResultAcknowledgementBasisChangedError,
  ResultAcknowledgementBindingError,
  ResultAcknowledgementDuplicateError,
  ResultAcknowledgementNotClinicianError,
  ResultAcknowledgementNotFoundError,
  ResultAcknowledgementRequestReusedError,
} from '../storage/result-acknowledgements';
import { LedgerRecordsRepository } from '../storage/ledger-records.repository';

/** Result acknowledgements (spec 019 D02a). Postgres only, like every ledger record: without a database the routes answer "misconfigured". */
@Injectable()
export class ResultAcknowledgementsService {
  constructor(@Optional() private readonly ledger?: LedgerRecordsRepository) {}

  private need(): LedgerRecordsRepository {
    if (!this.ledger) throw AppException.pipelineMisconfigured();
    return this.ledger;
  }

  async record(principal: Principal, resultId: string, body: ResultAcknowledgementCreate): Promise<{ entry: ResultAcknowledgementDto; created: boolean }> {
    const acknowledgements = this.need();
    // The body names the result it was displayed for; a body sent to another result's path is refused before anything is read.
    if (body.resultId.toLowerCase() !== resultId) throw toAppError(new ResultAcknowledgementBindingError());
    // The fingerprint of the request: the fields the caller chose, never a value the server sets. A repeat with the same id and fingerprint returns
    // the stored acknowledgement; the same id with anything else is refused.
    const hash = canonicalHash({
      v: 'result-acknowledgement-request-v1',
      resultId,
      patientId: body.patientId.toLowerCase(),
      kind: body.kind,
      reviewTask: body.reviewTask,
      displayedBasis: body.displayedBasis,
    });
    try {
      const { record, created } = await acknowledgements.insertResultAcknowledgement(principal.tenantId, principal.sub, {
        resultId,
        patientId: body.patientId.toLowerCase(),
        kind: body.kind,
        reviewTask: body.reviewTask,
        displayedBasis: body.displayedBasis,
        request: { id: body.requestId.toLowerCase(), hash },
      });
      return { entry: toDto(record), created };
    } catch (error) {
      throw toAppError(error);
    }
  }

  async list(principal: Principal, resultId: string): Promise<ResultAcknowledgementsDto> {
    const found = await this.need().resultAcknowledgements(principal.tenantId, resultId);
    if (!found) throw AppException.notFound('Result not found.');
    return {
      resultId: found.basis.resultId,
      evaluationId: found.basis.evaluationId,
      patientId: found.basis.patientId,
      basis: found.basis.basis,
      // A review made in a basis that has since changed (a retraction, say) is kept, and reads as historical.
      acknowledgements: found.entries
        .map(toDto)
        .map((entry) => ({ ...entry, basisIsCurrent: sameAckBasis(entry.basis, found.basis.basis), byYou: entry.createdBy === principal.sub })),
      clinicalUse: 'not-approved',
      actionable: false,
    };
  }
}

function toAppError(error: unknown): unknown {
  if (error instanceof ResultAcknowledgementNotFoundError) return AppException.notFound('Result not found.');
  if (error instanceof ResultAcknowledgementRequestReusedError) {
    return AppException.conflictBecause(ACK_REFUSAL_REASONS.requestIdReused, 'That request id was already used for a different acknowledgement.');
  }
  if (error instanceof ResultAcknowledgementBindingError) {
    return AppException.conflictBecause(ACK_REFUSAL_REASONS.bindingMismatch, 'The result or patient named does not match this result.');
  }
  if (error instanceof ResultAcknowledgementBasisChangedError) {
    return AppException.conflictBecause(ACK_REFUSAL_REASONS.basisChanged, 'The result changed since it was displayed: read it again before reviewing it.');
  }
  if (error instanceof ResultAcknowledgementDuplicateError) {
    return AppException.conflictBecause(ACK_REFUSAL_REASONS.alreadyAcknowledged, 'You already recorded this review of this result.');
  }
  if (error instanceof ResultAcknowledgementNotClinicianError) return AppException.forbidden();
  return error;
}

function toDto(p: Projected): ResultAcknowledgementDto {
  return {
    id: p.id as string,
    resultId: p.resultId as string,
    evaluationId: p.evaluationId as string,
    patientId: p.patientId as string,
    kind: p.acknowledgementKind as ResultAcknowledgementDto['kind'],
    reviewTask: p.reviewTask as ResultAcknowledgementDto['reviewTask'],
    basis: p.basis as ResultAcknowledgementDto['basis'],
    basisRule: p.basisRule as ResultAcknowledgementDto['basisRule'],
    createdAt: p.createdAt as string,
    createdBy: p.createdBy as string,
    authorRoles: p.authorRoles as string[],
  };
}
