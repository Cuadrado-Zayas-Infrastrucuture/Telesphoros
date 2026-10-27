import {
  type AcceptanceDto,
  acceptanceDtoSchema,
  type CaptureDto,
  captureDtoSchema,
  CLINICAL_USE,
  type CorrectionDto,
  correctionDtoSchema,
  type DisputeDto,
  disputeDtoSchema,
  type EvaluationDto,
  evaluationDtoSchema,
  type EvaluationSummaryDto,
  evaluationSummaryDtoSchema,
  type NoteDto,
  noteDtoSchema,
} from '@telesphoros/shared-types';
import { REPORT_HOLD_ACTIONS, REPORT_HOLD_MESSAGES, type ReportHoldCode } from '../services/report-adapter';
import type { KnowledgeSet } from '../services/knowledge/knowledge-set';
import type { DisputeStatus, NoteRecord, Projected } from '../storage/ledger-records';

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

export function toCorrectionDto(record: Projected): CorrectionDto {
  return correctionDtoSchema.parse({
    id: record.id,
    evaluationId: record.evaluationId,
    kind: record.correctionKind,
    reasonCode: record.reasonCode,
    previousCorrectionId: record.previousCorrectionId ?? null,
    replacementEvaluationId: record.replacementEvaluationId ?? null,
    note: record.note ?? null,
    createdAt: record.createdAt,
  });
}

export function toNoteDto(note: NoteRecord): NoteDto {
  return noteDtoSchema.parse({ id: note.id, body: note.body, bodySha256: note.bodySha256, redacted: note.redacted, createdAt: note.createdAt });
}

/**
 * The state of an evaluation, derived from its corrections (oldest first), exactly as specification 4.4 defines it: active when there is
 * none or the last is a reinstatement, retracted when the last is a retraction, superseded (terminal) when the last is a supersession.
 */
export function stateFromCorrections(corrections: Projected[]): { state: 'active' | 'retracted' | 'superseded'; by: string | null } {
  const last = corrections[corrections.length - 1];
  if (!last || last.correctionKind === 'reinstatement') return { state: 'active', by: null };
  if (last.correctionKind === 'retraction') return { state: 'retracted', by: null };
  return { state: 'superseded', by: last.replacementEvaluationId as string };
}

/** How an evaluation reads: its stored facts, whether the decision it relied on is still the latest, its corrections, and what is disputed now. */
export interface EvaluationContext {
  acceptance: { id: string; decision: 'accepted' | 'rejected'; current: boolean } | null;
  /** Oldest first. The state shown is derived from these, so the two can never disagree. */
  corrections: Projected[];
  current: boolean;
  activeDisputes: number;
  /** Whether the report's file is verified as the patient's, rejected (quarantined), or not decided. */
  patientLink: 'verified' | 'unverified' | 'rejected';
}

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);

export function toEvaluationDto(record: Projected, context: EvaluationContext): EvaluationDto {
  const holdCode = text(record.holdCode);
  const derived = stateFromCorrections(context.corrections);
  const binding = (record.binding ?? {}) as Record<string, unknown>;
  const results = (record.results as Array<Record<string, unknown>>).map((r) => ({
    id: r.id,
    ordinal: r.ordinal,
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
    hold:
      holdCode && holdCode in REPORT_HOLD_MESSAGES
        ? { message: REPORT_HOLD_MESSAGES[holdCode as ReportHoldCode], reviewerAction: REPORT_HOLD_ACTIONS[holdCode as ReportHoldCode] }
        : null,
    knowledgeSetId: record.knowledgeSetId,
    engineVersion: record.engineVersion,
    scope: text(binding.scope),
    clinicalUse: CLINICAL_USE,
    state: derived.state,
    supersededBy: derived.by,
    results,
    geneStates: (record.geneStates as Array<Record<string, unknown>>).map((s) => ({
      gene: s.gene,
      state: s.state,
      phenotype: text(s.phenotype),
      diplotype: text(s.diplotype),
      activityScore: text(s.activityScore),
      reasonCode: text(s.reasonCode),
    })),
    geneInputs: record.geneInputs,
    corrections: context.corrections.map(toCorrectionDto),
    current: context.current,
    advisory: { activeDisputes: context.activeDisputes, patientLink: context.patientLink },
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

/**
 * A dispute as the API shows it. `inForce` says whether it holds a cell NOW: open or upheld, and the loaded knowledge file is still the one
 * whose content hash was disputed (a corrected, re-signed file has another hash, so the hold lifts by itself).
 */
export function toDisputeDto(status: DisputeStatus, knowledge: KnowledgeSet): DisputeDto {
  const d = status.dispute;
  const file = knowledge.files.find((f) => f.kind === 'guideline' && f.id === d.guidelineId);
  const loadedVersion = knowledge.allGuidelines().find((g) => g.id === d.guidelineId)?.guidelineVersion;
  const sameFile = file !== undefined && file.contentSha256 === d.guidelineContentSha256 && loadedVersion === d.guidelineVersion;
  const decision = status.decision;
  return disputeDtoSchema.parse({
    id: d.id,
    guidelineId: d.guidelineId,
    guidelineVersion: d.guidelineVersion,
    guidelineContentSha256: d.guidelineContentSha256,
    locator: { table: d.locatorTable, row: d.locatorRow, column: d.locatorColumn ?? null },
    status: status.status,
    inForce: status.status !== 'dismissed' && sameFile,
    note: d.note ?? null,
    decision: decision ? { id: decision.id, decision: decision.decision, evidence: decision.evidence ?? null, createdAt: decision.createdAt } : null,
    createdAt: d.createdAt,
  });
}
