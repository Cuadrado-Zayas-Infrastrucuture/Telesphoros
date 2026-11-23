import {
  CLINICAL_USE,
  type ContextNotice,
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
  /** Spec 045 D4: a modifier with no recorded start is named with that said. Absent reads as not recorded. */
  startMonth?: string | null;
}

/** Spec 045 N1: what a loaded gene modifier list says about one ingredient and gene (`GeneModifier`, read through its fields only). */
export interface ProfileModifier {
  gene: string;
  effect: 'inhibitor' | 'inducer';
  strength: 'strong' | 'moderate';
  locator: { table: string; row?: string };
  listId: string;
  source: string;
  sourceVersion: string;
  sourceUrl: string;
}

/** The loaded lists, looked up by exact RxNorm id (PN-3). Undefined while none is loaded (PN-6). */
export type ModifierLookup = (rxcui: string) => readonly ProfileModifier[];

export interface ProfileInput {
  patientId: string;
  evaluations: readonly ProfileEvaluation[];
  medications: readonly ProfileMedication[];
  /** `?rxcui=`, or undefined. */
  checkRxcui?: string;
  capped: boolean;
  /** Spec 045 N2: the loaded gene modifier lists; undefined when none is loaded. */
  modifiersOf?: ModifierLookup;
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

/**
 * Spec 045 N2, rules 2, 4 and 5 of plan-slice-n2.md: one notice for every gene asked about and every current, active medication a loaded list
 * names against it, by exact RxNorm id, in gene order and then medication name order. A medication recorded twice gives one notice.
 */
function noticesFor(genes: Iterable<string>, active: readonly ProfileMedication[], modifiersOf: ModifierLookup): ContextNotice[] {
  const medications = [...active].sort((a, b) => byText(a.name, b.name) || byText(a.rxcui, b.rxcui));
  const notices: ContextNotice[] = [];
  const seen = new Set<string>();
  for (const gene of [...new Set(genes)].sort(byText)) {
    for (const medication of medications) {
      for (const modifier of modifiersOf(medication.rxcui)) {
        const key = `${gene}\0${medication.rxcui}`;
        if (modifier.gene !== gene || seen.has(key)) continue;
        seen.add(key);
        notices.push({
          kind: 'gene-modifier',
          gene,
          medication: { rxcui: medication.rxcui, name: medication.name, startRecorded: Boolean(medication.startMonth) },
          effect: modifier.effect,
          strength: modifier.strength,
          source: {
            listId: modifier.listId,
            source: modifier.source,
            sourceVersion: modifier.sourceVersion,
            sourceUrl: modifier.sourceUrl,
            table: modifier.locator.table,
            row: modifier.locator.row ?? null,
          },
        });
      }
    }
  }
  return notices;
}

export function buildGenomicProfile(input: ProfileInput): GenomicProfileDto {
  const used = input.evaluations.filter((e) => usable(e.evaluation));
  const genes = genesOf(used);
  // Rule 1: only current, active medications are modifiers (D4, P-D3); a stopped one never is.
  const active = input.medications.filter((m) => m.current && m.status === 'active');
  const medications = active.map((m) => checkOf(m.rxcui, m.name, used, genes));
  const check = input.checkRxcui === undefined ? null : checkOf(input.checkRxcui, null, used, genes);
  const profile: GenomicProfileDto = {
    patientId: input.patientId,
    clinicalUse: CLINICAL_USE,
    capped: input.capped,
    genes,
    awaitingLinkReview: input.evaluations.filter((e) => awaitingLink(e.evaluation)).map((e) => ({ evaluationId: e.evaluation.id, reportId: e.evaluation.reportId })),
    medications,
    check,
  };
  const { modifiersOf } = input;
  // Rule 7 (PN-6): with no list loaded, nothing is added but the flag that says so.
  if (!modifiersOf) return { ...profile, modifierLists: { loaded: false } };
  // Rules 2 and 3: a check's notices come from the genes its matching results used, so a check with no result has none. Rule 4: a card's from its gene.
  const withNotices = (c: GenomicCheck): GenomicCheck => ({
    ...c,
    contextNotices: noticesFor(
      c.results.flatMap((r) => r.genes),
      active,
      modifiersOf,
    ),
  });
  return {
    ...profile,
    genes: genes.map((gene) => ({ ...gene, contextNotices: noticesFor([gene.gene], active, modifiersOf) })),
    medications: medications.map(withNotices),
    check: check === null ? null : withNotices(check),
    modifierLists: { loaded: true },
  };
}
