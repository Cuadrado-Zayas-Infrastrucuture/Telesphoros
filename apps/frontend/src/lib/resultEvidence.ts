import { REASON_CODES, REASON_MESSAGES, RETIRED_REASON_CODES, REVIEWER_ACTIONS, type ReasonCode } from '@telesphoros/cpic-schema/vocabulary';
import type { EvaluationSummaryDto } from '@telesphoros/shared-types';

// What a stored result rests on, read from the result itself (specs/038 D7). Nothing here decides anything: it sorts fields the API already
// sent into "used", "missing" and "changed", with the fixed wording of the reason-code vocabulary. A value the result does not carry is
// reported as not recorded; it is never assumed.

type Evaluation = Pick<EvaluationSummaryDto, 'geneStates' | 'disposition' | 'hold' | 'holdCode' | 'advisory' | 'corrections' | 'state'>;
type Result = Pick<EvaluationSummaryDto['results'][number], 'genes' | 'outcome' | 'reasonCode'>;

/** A gene result the assessment used. */
export interface UsedInput {
  gene: string;
  phenotype: string;
  /** Diplotype and activity score, when the result carries them. */
  detail: string | null;
}

/** Something the assessment needed and did not have. `about` keeps a gap in the guidelines apart from a gap in the patient's report. */
export interface MissingItem {
  about: 'report' | 'guideline' | 'assessment';
  gene: string | null;
  message: string;
  /** What a reviewer does next, from the vocabulary or the API. Null when no reviewer action is specified. */
  nextStep: string | null;
}

export interface ChangeItem {
  message: string;
  when: string | null;
}

export interface ResultEvidenceView {
  used: UsedInput[];
  /** Genes the result names for which no state came with it. */
  notRecorded: string[];
  missing: MissingItem[];
  changes: ChangeItem[];
}

/**
 * Whether a reason is about the patient's report or about the guidelines and definitions (specs/038 D7). Every code is placed, so a new
 * code fails to compile here until someone decides where it belongs.
 */
const REASON_ABOUT: Readonly<Record<ReasonCode, 'report' | 'guideline'>> = {
  'duplicate-gene-conflict': 'report',
  'duplicate-identical': 'report',
  'sentinel-literal-in-source': 'report',
  'other-gene-unresolved': 'report',
  'gene-absent': 'report',
  'malformed-diplotype': 'report',
  'association-abstained': 'report',
  'out-of-review-scope': 'guideline',
  'cell-disputed': 'guideline',
  'allele-not-in-definitions': 'guideline',
  'no-phenotype-mapping': 'guideline',
  'no-gene-definition': 'guideline',
  'knowledge-gap': 'guideline',
  'no-published-recommendation': 'guideline',
  'no-guideline-for-drug': 'guideline',
};

/** The current code for a stored reason, following a retired name to its replacement. Null for a code this screen does not know. */
function knownReason(code: string | null): ReasonCode | null {
  if (code === null) return null;
  if ((REASON_CODES as readonly string[]).includes(code)) return code as ReasonCode;
  return RETIRED_REASON_CODES[code] ?? null;
}

const UNKNOWN_REASON = 'This item was not used. This view cannot interpret the reason code. See “Technical details”.';

function missingFor(code: string | null, gene: string | null): MissingItem {
  const reason = knownReason(code);
  if (!reason) return { about: 'assessment', gene, message: UNKNOWN_REASON, nextStep: null };
  return { about: REASON_ABOUT[reason], gene, message: REASON_MESSAGES[reason], nextStep: REVIEWER_ACTIONS[reason] };
}

const CORRECTION_WORDS: Readonly<Record<EvaluationSummaryDto['corrections'][number]['kind'], string>> = {
  retraction: 'Result withdrawn.',
  supersession: 'Result replaced by another result.',
  reinstatement: 'Result reinstated after withdrawal.',
};

export function resultEvidence(evaluation: Evaluation, result: Result): ResultEvidenceView {
  const used: UsedInput[] = [];
  const notRecorded: string[] = [];
  const missing: MissingItem[] = [];
  if (evaluation.disposition === 'held')
    missing.push({
      about: 'assessment',
      gene: null,
      message: evaluation.hold?.message ?? 'The entire assessment is on hold.',
      nextStep: evaluation.hold?.reviewerAction ?? null,
    });
  const geneReasons = new Set<string>();
  for (const gene of result.genes) {
    const state = evaluation.geneStates.find((entry) => entry.gene === gene);
    if (!state) {
      notRecorded.push(gene);
    } else if (state.state === 'canonical' && state.phenotype) {
      const detail = [state.diplotype && `diplotype: ${state.diplotype}`, state.activityScore && `activity score: ${state.activityScore}`].filter(Boolean).join('; ');
      used.push({ gene, phenotype: state.phenotype, detail: detail || null });
    } else {
      // Absent, null, unresolved, or a state this screen does not know: never read as a normal result.
      if (state.reasonCode) geneReasons.add(knownReason(state.reasonCode) ?? state.reasonCode);
      missing.push(missingFor(state.reasonCode, gene));
    }
  }
  // The result's own reason, unless a gene above already says the same thing.
  if (result.reasonCode !== null && !geneReasons.has(knownReason(result.reasonCode) ?? result.reasonCode)) missing.push(missingFor(result.reasonCode, null));

  const changes: ChangeItem[] = evaluation.corrections.map((correction) => ({ message: CORRECTION_WORDS[correction.kind], when: correction.createdAt }));
  switch (evaluation.advisory.knowledge?.status) {
    case 'same':
      break;
    case 'changed':
      // The API says only that the two sets differ, not what differs (shared-types, `advisory.knowledge`).
      changes.push({ message: 'The current guideline set differs from the set used for this result. This comparison does not identify what changed.', when: null });
      break;
    default:
      changes.push({ message: 'Could not confirm whether this result used the current guideline set.', when: null });
  }
  return { used, notRecorded, missing, changes };
}
