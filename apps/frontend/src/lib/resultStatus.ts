import { OUTCOMES, REASON_MESSAGES, RETIRED_REASON_CODES, type Outcome, type ReasonCode } from '@telesphoros/cpic-schema/vocabulary';
import type { EvaluationDto } from '@telesphoros/shared-types';

// Plain words for what a stored result is and what to do with it. The wording was approved by the founder as pharmacist (audit T5:
// UXT-02, UXT-06, UXT-18, CLIN-06); the raw codes stay in each result's provenance disclosure.

type Evaluation = Pick<EvaluationDto, 'state' | 'current' | 'advisory'>;
type Result = Pick<EvaluationDto['results'][number], 'outcome' | 'reasonCode'>;

export interface Notice {
  tone: 'destructive' | 'warning';
  message: string;
}

/**
 * What a reader must know before relying on an evaluation, most serious first. `fold` is true when the evaluation is not the current one:
 * its wording is then folded behind a disclosure and never reads as current guidance.
 */
export function evaluationStanding(evaluation: Evaluation): { notices: Notice[]; fold: boolean } {
  const notices: Notice[] = [];
  switch (evaluation.state) {
    case 'retracted':
      notices.push({ tone: 'destructive', message: 'Withdrawn. Do not use this result.' });
      break;
    case 'superseded':
      notices.push({ tone: 'destructive', message: 'Replaced by a newer result. Do not use this one.' });
      break;
    case 'active':
      break;
    default:
      return unreachable(evaluation.state);
  }
  switch (evaluation.advisory.patientLink) {
    case 'rejected':
      notices.push({ tone: 'destructive', message: 'This report may belong to another patient. Do not use it.' });
      break;
    case 'unverified':
      notices.push({ tone: 'warning', message: 'Not yet confirmed that this report belongs to this patient.' });
      break;
    case 'verified':
      break;
    default:
      return unreachable(evaluation.advisory.patientLink);
  }
  const fold = !evaluation.current || evaluation.state !== 'active' || evaluation.advisory.patientLink === 'rejected';
  if (fold && !notices.some((notice) => notice.tone === 'destructive')) notices.unshift({ tone: 'warning', message: 'Not the current result for this report.' });
  // Only a result that still reads as current needs this: any other already says not to use it.
  const knowledge = fold ? null : knowledgeNotice(evaluation.advisory.knowledge?.status);
  if (knowledge) notices.push(knowledge);
  return { notices, fold };
}

/** Whether the guidelines this result used are still in use (audit CLIN-02). An API older than this screen sends nothing, and that reads as `unknown`. */
function knowledgeNotice(status: NonNullable<Evaluation['advisory']['knowledge']>['status'] | undefined): Notice | null {
  switch (status) {
    case 'same':
      return null;
    case 'changed':
      return { tone: 'warning', message: 'The guidelines have changed since this result was made. A pharmacist must check whether it still applies.' };
    case 'unknown':
    case undefined:
      return { tone: 'warning', message: 'Could not confirm that this result used the guidelines in use now.' };
    default:
      return unreachable(status);
  }
}

const isOutcome = (value: string): value is Outcome => (OUTCOMES as readonly string[]).includes(value);

/** The outcome in plain words. An outcome this screen does not know reads "Could not be evaluated", never as a recommendation. */
export function outcomeLabel(outcome: string): string {
  if (!isOutcome(outcome)) return 'Could not be evaluated';
  switch (outcome) {
    case 'shown':
      return 'Recommendation';
    case 'held':
      return 'On hold: needs review';
    case 'abstained':
      return 'Could not be evaluated';
    case 'no-published-recommendation':
      return 'The guideline gives no recommendation for this case';
    case 'no-guideline':
      return 'No guideline for this drug';
    default:
      return unreachable(outcome);
  }
}

/**
 * Guideline wording is displayed only for the two outcomes whose wording comes from a verified cell: `shown`, and a verified cell that itself
 * says "No recommendation" (docs/design/outcomes-and-reason-codes.md). Anything else, an unknown outcome included, displays none.
 */
export const showsWording = (result: Result) => result.outcome === 'shown' || result.outcome === 'no-published-recommendation';
const hasRecommendation = (result: Result) => result.outcome === 'shown';

/** Why a held or abstained result has nothing to show, in plain words; null when the outcome label already says it all. */
export function reasonMessage(result: Result): string | null {
  if (result.outcome !== 'held' && result.outcome !== 'abstained') return null;
  const code = result.reasonCode;
  if (code === null) return null;
  if (code in REASON_MESSAGES) return REASON_MESSAGES[code as ReasonCode];
  const renamed = RETIRED_REASON_CODES[code];
  return renamed ? REASON_MESSAGES[renamed] : null;
}

/**
 * The evaluation as a whole. A warning when any drug has no recommendation. Otherwise it only says the assessment finished: that is not
 * a verdict on what the recommendations say, so it is never green (specs/038 D6).
 */
export function evaluationLine(results: readonly Result[]): { tone: 'neutral' | 'warning'; message: string } {
  const total = results.length;
  const missing = results.filter((result) => !hasRecommendation(result)).length;
  const held = results.filter((result) => result.outcome === 'held').length;
  if (total > 0 && held === total) return { tone: 'warning', message: `No drug could be evaluated. ${held} on hold.` };
  if (total === 0) return { tone: 'warning', message: 'No drug could be evaluated.' };
  if (missing > 0) return { tone: 'warning', message: `${missing} of ${total} drugs ${missing === 1 ? 'has' : 'have'} no recommendation.` };
  return { tone: 'neutral', message: total === 1 ? 'Assessment completed. 1 drug evaluated.' : `Assessment completed. All ${total} drugs evaluated.` };
}

function unreachable(value: never): never {
  throw new Error(`Unhandled value: ${String(value)}`);
}
