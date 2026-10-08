import {
  type AcceptanceDto, acceptanceDtoSchema, type CaptureDto, captureDtoSchema, CLINICAL_USE, type EvaluationDto, evaluationDtoSchema, type EvaluationSummaryDto,
  evaluationSummaryDtoSchema,
} from '@telesphoros/shared-types';
import { REPORT_HOLD_ACTIONS, REPORT_HOLD_MESSAGES, type ReportHoldCode } from '../services/report-adapter';
import type { Projected } from '../storage/ledger-records';

/**
 * Stored record -> public shape. These are allow-lists: a field that is not named here (the storage key, the identity of the person who
 * created the record, the ledger event id) cannot reach a response, and the strict schemas fail loudly if the stored shape ever changes.
 */
export function toAcceptanceDto(record: Projected): AcceptanceDto {
  return acceptanceDtoSchema.parse({
    id: record.id,
    captureId: record.captureId,
    decision: record.decision,
    textSha256: record.textSha256,
    popplerVersion: record.popplerVersion,
    note: record.note ?? null,
    createdAt: record.createdAt,
  });
}

export function toCaptureDto(record: Projected, latestDecision: Projected | undefined): CaptureDto {
  return captureDtoSchema.parse({
    id: record.id,
    reportId: record.reportId,
    pdfSha256: record.pdfSha256,
    textSha256: record.textSha256,
    textScalars: record.textScalars,
    popplerVersion: record.popplerVersion,
    runner: record.runner,
    createdAt: record.createdAt,
    latestDecision: latestDecision ? toAcceptanceDto(latestDecision) : null,
  });
}

/** How an evaluation reads: its stored facts, whether the decision it relied on is still the latest, and what is disputed now. */
export interface EvaluationContext {
  acceptance: { id: string; decision: 'accepted' | 'rejected'; current: boolean } | null;
  state: { state: 'active' | 'retracted' | 'superseded'; by: string | null };
  activeDisputes: number;
}

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

export function toEvaluationDto(record: Projected, context: EvaluationContext): EvaluationDto {
  const holdCode = text(record.holdCode);
  const binding = (record.binding ?? {}) as Record<string, unknown>;
  const results = (record.results as Array<Record<string, unknown>>).map((r) => ({
    drug: r.drug,
    genes: r.genes,
    outcome: r.outcome,
    reasonCode: text(r.reasonCode),
    strength: text(r.strength),
    citation: r.citation ?? null,
    recommendationText: text(r.recommendationText),
    implication: text(r.implication),
    geneEvidence: r.geneEvidence ?? null,
  }));
  return evaluationDtoSchema.parse({
    id: record.id,
    reportId: record.reportId,
    patientId: record.patientId,
    captureId: record.captureId,
    acceptance: context.acceptance,
    disposition: record.disposition,
    holdCode,
    hold: holdCode && holdCode in REPORT_HOLD_MESSAGES ? { message: REPORT_HOLD_MESSAGES[holdCode as ReportHoldCode], reviewerAction: REPORT_HOLD_ACTIONS[holdCode as ReportHoldCode] } : null,
    knowledgeSetId: record.knowledgeSetId,
    engineVersion: record.engineVersion,
    scope: text(binding.scope),
    clinicalUse: CLINICAL_USE,
    state: context.state.state,
    supersededBy: context.state.by,
    results,
    geneStates: (record.geneStates as Array<Record<string, unknown>>).map((s) => ({
      gene: s.gene, state: s.state, phenotype: text(s.phenotype), diplotype: text(s.diplotype), activityScore: text(s.activityScore), reasonCode: text(s.reasonCode),
    })),
    geneInputs: record.geneInputs,
    corrections: [],
    advisory: { activeDisputes: context.activeDisputes },
    // Not approved for clinical use, so never "actionable" at this stage; also false whenever the state is not active or a dispute is open.
    actionable: false,
    createdAt: record.createdAt,
  });
}

export function toEvaluationSummaryDto(record: Projected, context: EvaluationContext): EvaluationSummaryDto {
  const detail: Record<string, unknown> = { ...toEvaluationDto(record, context) };
  delete detail.geneInputs; // the engine's inputs are for the detail only
  return evaluationSummaryDtoSchema.parse(detail);
}
