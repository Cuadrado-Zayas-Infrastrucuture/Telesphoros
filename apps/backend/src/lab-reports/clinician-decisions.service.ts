import { Injectable, Optional } from '@nestjs/common';
import { type ClinicianDecisionCreate, type ClinicianDecisionDto, type ClinicianDecisionHistoryDto, cdrCurrentDecisionId, ErrorCode } from '@telesphoros/shared-types';
import { AppException } from '../common/app-exception';
import type { Principal } from '../auth/principal';
import type { Projected } from '../storage/ledger-records';
import { canonicalHash } from '../services/report-adapter/canonical-json';
import {
  ClinicianDecisionBasisError,
  ClinicianDecisionBindingError,
  ClinicianDecisionNotAuthorError,
  ClinicianDecisionNotClinicianError,
  ClinicianDecisionNotFoundError,
  ClinicianDecisionRequestReusedError,
  ClinicianDecisionRuleError,
  ClinicianDecisionStaleError,
} from '../storage/clinician-decisions';
import { LedgerRecordsRepository } from '../storage/ledger-records.repository';

/** Clinician result decisions (spec 006 D01b). Postgres only, like every ledger record: without a database the routes answer "misconfigured". */
@Injectable()
export class ClinicianDecisionsService {
  constructor(@Optional() private readonly ledger?: LedgerRecordsRepository) {}

  private need(): LedgerRecordsRepository {
    if (!this.ledger) throw AppException.pipelineMisconfigured();
    return this.ledger;
  }

  async record(principal: Principal, resultId: string, body: ClinicianDecisionCreate): Promise<{ entry: ClinicianDecisionDto; created: boolean }> {
    const decisions = this.need();
    const occurredAt = body.occurredAt === undefined ? undefined : new Date(body.occurredAt).toISOString();
    const detailCodes = [...body.detailCodes];
    // The fingerprint of the request: the fields the caller chose, never a value the server sets. A repeat with the same id and fingerprint
    // returns the stored entry; the same id with anything else is refused.
    const hash = canonicalHash({
      v: 'clinician-decision-request-v1',
      resultId: resultId.toLowerCase(),
      evaluationId: body.evaluationId.toLowerCase(),
      patientId: body.patientId.toLowerCase(),
      entryKind: body.entryKind,
      previousEntryId: body.previousEntryId?.toLowerCase() ?? null,
      response: body.response,
      detailCodes,
      reviewBy: body.reviewBy,
      note: body.note ?? null,
      occurredAt: occurredAt ?? null,
    });
    try {
      const { record: entry, created } = await decisions.insertClinicianDecision(principal.tenantId, principal.sub, {
        resultId,
        evaluationId: body.evaluationId.toLowerCase(),
        patientId: body.patientId.toLowerCase(),
        entryKind: body.entryKind,
        previousEntryId: body.previousEntryId?.toLowerCase() ?? null,
        response: body.response,
        detailCodes,
        reviewBy: body.reviewBy,
        ...(body.note === undefined ? {} : { note: body.note }),
        ...(occurredAt === undefined ? {} : { occurredAt }),
        request: { id: body.requestId.toLowerCase(), hash },
      });
      return { entry: toDto(entry), created };
    } catch (error) {
      throw toAppError(error);
    }
  }

  async history(principal: Principal, resultId: string): Promise<ClinicianDecisionHistoryDto> {
    const found = await this.need().clinicianDecisionHistory(principal.tenantId, resultId);
    if (!found) throw AppException.notFound('Result not found.');
    const entries = found.entries.map(toDto);
    const successors = new Set(entries.map((e) => e.previousEntryId));
    return {
      resultId: found.basis.resultId,
      evaluationId: found.basis.evaluationId,
      patientId: found.basis.patientId,
      basis: found.basis.basis,
      headEntryId: entries.find((e) => !successors.has(e.id))?.id ?? null,
      currentDecisionId: cdrCurrentDecisionId(entries),
      entries,
      clinicalUse: 'not-approved',
      actionable: false,
    };
  }
}

function toAppError(error: unknown): unknown {
  if (error instanceof ClinicianDecisionNotFoundError) return AppException.notFound('Result not found.');
  if (error instanceof ClinicianDecisionRequestReusedError) return AppException.conflictBecause('request-id-reused', 'That request id was already used for a different entry.');
  if (error instanceof ClinicianDecisionBindingError) {
    return AppException.conflictBecause('decision-binding-mismatch', 'The evaluation or patient named does not match this result.');
  }
  if (error instanceof ClinicianDecisionBasisError) {
    return AppException.conflictBecause('decision-basis-unavailable', 'This result is not on a current, undisputed, unheld evaluation, so no decision can be recorded on it.');
  }
  if (error instanceof ClinicianDecisionStaleError) return AppException.conflictBecause('decision-stale', 'The history changed: read it again and name its newest entry.');
  if (error instanceof ClinicianDecisionNotAuthorError) {
    const message = 'Only the author of an entry may amend or withdraw it.';
    return new AppException(403, ErrorCode.FORBIDDEN, message, [{ field: 'previousEntryId', message, reason: 'not-entry-author' }]);
  }
  if (error instanceof ClinicianDecisionNotClinicianError) return AppException.forbidden();
  if (error instanceof ClinicianDecisionRuleError) return AppException.validation([{ field: error.field, message: 'This entry breaks a clinician decision rule.' }]);
  return error;
}

function toDto(p: Projected): ClinicianDecisionDto {
  return {
    id: p.id as string,
    resultId: p.resultId as string,
    evaluationId: p.evaluationId as string,
    patientId: p.patientId as string,
    entryKind: p.entryKind as ClinicianDecisionDto['entryKind'],
    previousEntryId: (p.previousEntryId as string | null) ?? null,
    response: (p.response as ClinicianDecisionDto['response']) ?? null,
    detailCodes: p.detailCodes as ClinicianDecisionDto['detailCodes'],
    reviewBy: (p.reviewBy as string | null) ?? null,
    vocabularyVersion: p.vocabularyVersion as ClinicianDecisionDto['vocabularyVersion'],
    eligibilityPolicy: p.eligibilityPolicy as ClinicianDecisionDto['eligibilityPolicy'],
    note: (p.note as ClinicianDecisionDto['note']) ?? null,
    occurredAt: p.occurredAt as string,
    occurredAtSource: p.occurredAtSource as ClinicianDecisionDto['occurredAtSource'],
    createdAt: p.createdAt as string,
    createdBy: p.createdBy as string,
    authorRoles: p.authorRoles as string[],
  };
}
