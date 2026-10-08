import { Injectable, Optional } from '@nestjs/common';
import { type CorrectionCreate, type CorrectionDto, type NoteDto } from '@telesphoros/shared-types';
import type { Principal } from '../auth/principal';
import { AppException } from '../common/app-exception';
import { LedgerRecordsRepository } from '../storage/ledger-records.repository';
import type { Projected } from '../storage/ledger-records';
import { stateFromCorrections, toCorrectionDto, toNoteDto } from './lab-report.mapper';

/**
 * Corrections of stored evaluations (specification 4). An evaluation is never edited: a correction is a new, ledgered row about it.
 *
 * The service checks every rule first so the answer is a clear 409 with a reason the reviewer can act on. Each rule that the database
 * can enforce is ALSO enforced there (constraints and triggers of migration 0009), which is what decides a race: two reviewers acting at
 * the same moment cannot both succeed, and the loser is told to reload.
 */
@Injectable()
export class CorrectionsService {
  constructor(@Optional() private readonly ledger?: LedgerRecordsRepository) {}

  private need(): LedgerRecordsRepository {
    if (!this.ledger) throw AppException.pipelineMisconfigured();
    return this.ledger;
  }

  async create(principal: Principal, evaluationId: string, body: CorrectionCreate): Promise<CorrectionDto> {
    const ledger = this.need();
    const tenantId = principal.tenantId;
    const evaluation = await ledger.findEvaluation(tenantId, evaluationId);
    if (!evaluation) throw AppException.notFound('Evaluation not found.');

    const history = await ledger.listCorrections(tenantId, evaluation.id);
    const last = history[history.length - 1];

    // The reviewer names the correction they saw last. Never filled in for them: they act on what they were looking at.
    if ((body.previousCorrectionId ?? null) !== (last?.id ?? null)) {
      throw AppException.conflictBecause('stale-chain', 'This evaluation has changed since you loaded it. Reload it and decide again.');
    }

    const state = stateFromCorrections(history).state;
    if (state === 'superseded') throw AppException.conflictBecause('invalid-transition', 'A superseded evaluation takes no further corrections.');
    if (body.kind === 'reinstatement') {
      if (state !== 'retracted') throw AppException.conflictBecause('invalid-transition', 'Only a retracted evaluation can be reinstated.');
      if (last!.createdBy === principal.sub) throw AppException.conflictBecause('self-reinstatement', 'A retraction is reinstated by someone other than the person who made it.');
    } else if (state === 'retracted') {
      throw AppException.conflictBecause('invalid-transition', 'A retracted evaluation can only be reinstated.');
    }

    if (body.kind === 'supersession') await this.checkReplacement(tenantId, evaluation, body.replacementEvaluationId!);

    const { record } = await ledger.insertCorrection(tenantId, principal.sub, {
      evaluationId: evaluation.id,
      kind: body.kind,
      reasonCode: body.reasonCode,
      previousCorrectionId: body.previousCorrectionId,
      replacementEvaluationId: body.replacementEvaluationId,
      note: body.note,
    });
    return toCorrectionDto(record);
  }

  /** Reads one note. Free text lives outside the ledger; this is the only place its body is returned. */
  async note(principal: Principal, id: string): Promise<NoteDto> {
    const note = await this.need().findNote(principal.tenantId, id);
    if (!note) throw AppException.notFound('Note not found.');
    return toNoteDto(note);
  }

  /**
   * The replacement must be another evaluation of the SAME report (the database also enforces this), NEWER than the one it replaces,
   * and itself active. A held replacement is allowed: "replaced by no result" is a legitimate outcome. The replacement could be
   * retracted a moment after this check; the history then reads correctly and no record is wrong, so this is recorded, not prevented.
   */
  private async checkReplacement(tenantId: string, evaluation: Projected, replacementId: string): Promise<void> {
    const ledger = this.need();
    const replacement = await ledger.findEvaluation(tenantId, replacementId);
    if (!replacement) throw AppException.notFound('Replacement evaluation not found.');
    if (replacement.id === evaluation.id) throw AppException.conflictBecause('bad-replacement', 'An evaluation cannot replace itself.');
    if (replacement.reportId !== evaluation.reportId) throw AppException.conflictBecause('bad-replacement', 'The replacement must be an evaluation of the same report.');
    if (BigInt(replacement.seq) <= BigInt(evaluation.seq)) throw AppException.conflictBecause('bad-replacement', 'The replacement must be newer than the evaluation it replaces.');
    const replacementState = stateFromCorrections(await ledger.listCorrections(tenantId, replacement.id)).state;
    if (replacementState !== 'active') throw AppException.conflictBecause('bad-replacement', 'The replacement has itself been retracted or superseded.');
  }
}
