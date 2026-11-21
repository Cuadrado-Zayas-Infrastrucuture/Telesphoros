import {
  CLINICAL_USE,
  type EvaluationSummaryDto,
  type GenomicCheck,
  type GenomicCheckResult,
  type GenomicCheckWord,
  type GenomicGene,
  type GenomicGeneSource,
  type GenomicProfileDto,
} from '@telesphoros/shared-types';

/**
 * Spec 044 slice A: the patient's genomic profile and the medication check, built from stored evaluations only (D6). A pure function: no
 * I/O, no engine, no clock. Every rule below is numbered as in `specs/044-genomic-profile-medication-check/plan-slice-a.md`.
 */

/** One current evaluation as the evaluation list presents it, with the RxCUI each stored result carries (by result id; null for schema 1.2). */
export interface ProfileEvaluation {
  evaluation: EvaluationSummaryDto;
  drugRxcuiByResultId: ReadonlyMap<string, string | null>;
}

/** The fields of a recorded medication the check needs. */
export interface ProfileMedication {
  rxcui: string;
  name: string;
  status: 'active' | 'stopped';
  current: boolean;
}

export interface ProfileInput {
  patientId: string;
  evaluations: readonly ProfileEvaluation[];
  medications: readonly ProfileMedication[];
  /** `?rxcui=`, or undefined. */
  checkRxcui?: string;
  capped: boolean;
}

/** Rule 1: current, active and verified. Only these feed the profile and the checks. */
const usable = (e: EvaluationSummaryDto) => e.current && e.state === 'active' && e.advisory.patientLink === 'verified';
/** Rule 1: current and active, but no second person has verified the patient link. Listed apart, used nowhere. */
const awaitingLink = (e: EvaluationSummaryDto) => e.current && e.state === 'active' && e.advisory.patientLink === 'unverified';

/** Code-unit order, the same in every locale (no `localeCompare`). */
function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** What a source says about its gene, when it resolved it: the phenotype, or the activity score where that is all it gives. */
function resolvedValue(source: GenomicGeneSource): string | null {
  if (source.phenotype !== null) return `phenotype:${source.phenotype}`;
  if (source.activityScore !== null) return `activity-score:${source.activityScore}`;
  return null;
}

/**
 * Rule 2: one entry per gene, every source listed. `conflict` when two sources resolved it differently; `not-resolved` when no source
 * resolved it; otherwise `resolved`. A source that could not resolve the gene beside one that did is listed, and is not a conflict: it says
 * nothing different, only less.
 */
function genesOf(evaluations: readonly ProfileEvaluation[]): GenomicGene[] {
  const byGene = new Map<string, GenomicGeneSource[]>();
  for (const { evaluation } of evaluations) {
    for (const state of evaluation.geneStates) {
      const sources = byGene.get(state.gene) ?? [];
      sources.push({
        evaluationId: evaluation.id,
        reportId: evaluation.reportId,
        evaluatedAt: evaluation.createdAt,
        state: state.state,
        phenotype: state.phenotype,
        diplotype: state.diplotype,
        activityScore: state.activityScore,
        reasonCode: state.reasonCode,
      });
      byGene.set(state.gene, sources);
    }
  }
  const entries = [...byGene.entries()].sort(([a], [b]) => byText(a, b));
  return entries.map(([gene, sources]) => {
    const values = new Set(sources.map(resolvedValue).filter((value): value is string => value !== null));
    const status = values.size === 0 ? 'not-resolved' : values.size > 1 ? 'conflict' : 'resolved';
    const ordered = [...sources].sort((a, b) => byText(a.evaluatedAt, b.evaluatedAt) || byText(a.evaluationId, b.evaluationId));
    return { gene, status, sources: ordered } as GenomicGene;
  });
}

/** Rule 4: Review before Held before No recommendation (founder decision P1); every matching result is still listed. */
function wordOf(results: readonly GenomicCheckResult[]): GenomicCheckWord {
  if (results.some((r) => r.outcome === 'shown')) return 'review';
  if (results.some((r) => r.outcome === 'held')) return 'held';
  if (results.some((r) => r.outcome === 'abstained' || r.outcome === 'no-published-recommendation')) return 'no-recommendation';
  return 'no-guideline-loaded';
}

const changed = (e: EvaluationSummaryDto) => e.advisory.knowledge?.status === 'changed';

function checkOf(rxcui: string, name: string | null, evaluations: readonly ProfileEvaluation[], genes: readonly GenomicGene[]): GenomicCheck {
  const matched: Array<{ evaluation: EvaluationSummaryDto; result: GenomicCheckResult }> = [];
  for (const { evaluation, drugRxcuiByResultId } of evaluations) {
    for (const result of evaluation.results) {
      // Rule 3: RxCUI equality only. A result with no RxCUI (schema 1.2 knowledge) matches nothing; no name is ever compared.
      const resultRxcui = drugRxcuiByResultId.get(result.id) ?? null;
      if (resultRxcui === null || resultRxcui !== rxcui) continue;
      matched.push({
        evaluation,
        result: {
          evaluationId: evaluation.id,
          resultId: result.id,
          outcome: result.outcome,
          reasonCode: result.reasonCode,
          strength: result.strength,
          recommendationText: result.recommendationText,
          implication: result.implication,
          citation: result.citation,
          genes: result.genes,
        },
      });
    }
  }
  const results = matched.map((m) => m.result);
  const word = wordOf(results);
  // Rule 5: a matching result that used a gene the sources disagree on.
  const conflicted = new Set(genes.filter((g) => g.status === 'conflict').map((g) => g.gene));
  const conflict = results.some((r) => r.genes.some((gene) => conflicted.has(gene)));
  // Rule 6: guidelines changed since a matching result; with no match, since any evaluation, because the loaded set may now have this drug.
  const knowledgeChanged = word === 'no-guideline-loaded' ? evaluations.some((e) => changed(e.evaluation)) : matched.some((m) => changed(m.evaluation));
  return { rxcui, name, word, knowledgeChanged, conflict, results };
}

export function buildGenomicProfile(input: ProfileInput): GenomicProfileDto {
  const used = input.evaluations.filter((e) => usable(e.evaluation));
  const genes = genesOf(used);
  return {
    patientId: input.patientId,
    clinicalUse: CLINICAL_USE,
    capped: input.capped,
    genes,
    awaitingLinkReview: input.evaluations.filter((e) => awaitingLink(e.evaluation)).map((e) => ({ evaluationId: e.evaluation.id, reportId: e.evaluation.reportId })),
    medications: input.medications.filter((m) => m.current && m.status === 'active').map((m) => checkOf(m.rxcui, m.name, used, genes)),
    check: input.checkRxcui === undefined ? null : checkOf(input.checkRxcui, null, used, genes),
  };
}
