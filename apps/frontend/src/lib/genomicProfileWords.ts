import { REASON_MESSAGES, REVIEWER_ACTIONS, RETIRED_REASON_CODES, type ReasonCode } from '@telesphoros/cpic-schema/vocabulary';
import type { GenomicCheck, GenomicCheckResult, GenomicCheckWord, GenomicGene, GenomicProfileDto } from '@telesphoros/shared-types';

/**
 * Spec 044 slice B: every fixed string of the genomic profile screen, in one place, so the founders can rewrite and sign them (G3) without
 * touching the screen. **Draft wording, from plan-slice-b.md section 5, awaiting G3.** English only: the Spanish is the founders' to write,
 * not machine translated, and until it exists the screen is English like the rest of the app.
 *
 * The server sends a word, never wording; these functions turn it into words. None of them ever says "safe", "no interaction", "normal
 * response" or "OK" except in the one sentence that says the opposite ("This does not mean it is safe.").
 */
export const PROFILE_WORDS = {
  heading: 'Genomic profile and medication check',
  intro: 'From confirmed reports only. CPIC wording is quoted exactly. Not approved for clinical use.',
  unavailable: 'The genomic profile is not available in this environment.',
  failed: 'Could not read the genomic profile.',
  // Named for what it retries: the patient page has its own Retry, and two buttons with one name are ambiguous to a screen reader.
  retry: 'Retry the genomic profile',
  loading: 'Reading the genomic profile…',
  medicationsHeading: 'Current medications, checked',
  noMedications: 'No current medications are recorded for this patient.',
  checkHeading: 'Check a drug before prescribing',
  checkNothingSaved: 'Nothing is saved.',
  checkChecking: 'Checking…',
  genesHeading: 'Genomic profile',
  noGenes: 'No confirmed report includes a gene result for this patient.',
  open: 'Why, and the evidence',
  close: 'Hide why and the evidence',
  whyHeading: 'Why',
  noImplication: 'CPIC gives no separate implication for this result.',
  evidenceHeading: 'The evidence',
  confirmed: 'Confirmed by a reviewer',
  notTested: 'Not tested',
  notTestedDetail: "This drug's guideline uses this gene, and no confirmed report includes it.",
  notResolved: 'Named in a report but not resolved from it.',
  knowledgeChanged: 'The guidelines have changed since this result was made. A pharmacist must check whether it still applies.',
  combination: 'Combination product: checked only as the combination. Its ingredients are not checked separately.',
  capped: 'Not every report is included here. Open Reports for the rest.',
} as const;

/** The word on screen for each API word (plan-slice-b.md section 5). */
export const WORD_LABELS: Readonly<Record<GenomicCheckWord, string>> = {
  review: 'Guidance to review',
  held: 'Held',
  'no-recommendation': 'No recommendation',
  'no-guideline-loaded': 'No guideline loaded',
};

const FIXED_SENTENCES: Readonly<Partial<Record<GenomicCheckWord, string>>> = {
  'no-recommendation': 'CPIC publishes no recommendation for this result.',
  'no-guideline-loaded': 'The loaded guidelines do not cover this drug. This does not mean it is safe.',
};

/** The one sentence that may contain "safe", because it says the opposite. Tests strip it before looking for reassuring words. */
export const NOT_SAFE_SENTENCE = 'This does not mean it is safe.';

function knownReason(code: string | null): ReasonCode | null {
  if (code === null) return null;
  if (code in REASON_MESSAGES) return code as ReasonCode;
  return RETIRED_REASON_CODES[code] ?? null;
}

/**
 * The sentence a check always carries. `review` has none of its own: the quoted recommendation is its sentence. `held` gives the first held
 * result's fixed reason message and the reviewer's next step, as the result screens already show them.
 */
export function checkSentence(check: Pick<GenomicCheck, 'word' | 'results'>): { message: string; nextStep: string | null } | null {
  if (check.word === 'held') {
    const reason = knownReason(check.results.find((result) => result.outcome === 'held')?.reasonCode ?? null);
    if (!reason) return { message: 'This result is held for review.', nextStep: null };
    return { message: REASON_MESSAGES[reason], nextStep: REVIEWER_ACTIONS[reason] ?? null };
  }
  const fixed = FIXED_SENTENCES[check.word];
  return fixed ? { message: fixed, nextStep: null } : null;
}

/** "1 of 4 current medications has guidance to review". Counts only; never "all clear" or "no issues". */
export function summaryLine(profile: Pick<GenomicProfileDto, 'medications'>): string {
  const total = profile.medications.length;
  if (total === 0) return PROFILE_WORDS.noMedications;
  const review = profile.medications.filter((check) => check.word === 'review').length;
  return `${review} of ${total} current medication${total === 1 ? '' : 's'} ${review === 1 ? 'has' : 'have'} guidance to review`;
}

/** The notice above the medications while reports wait for a second person to confirm the patient link. */
export function awaitingLine(count: number): string | null {
  if (count === 0) return null;
  const one = count === 1;
  const reports = one ? '1 report is' : `${count} reports are`;
  const belongs = one ? 'it belongs' : 'they belong';
  return `${reports} waiting for review. A second person has not yet confirmed that ${belongs} to this patient, so nothing from ${one ? 'it' : 'them'} is used below.`;
}

/** The genes the check's results used that two reports disagree about, for "Two reports disagree about [gene]." */
export function conflictLine(check: Pick<GenomicCheck, 'conflict' | 'results'>, genes: readonly GenomicGene[]): string | null {
  if (!check.conflict) return null;
  const used = new Set(check.results.flatMap((result) => result.genes));
  const names = genes.filter((gene) => gene.status === 'conflict' && used.has(gene.gene)).map((gene) => gene.gene);
  if (names.length === 0) return null;
  return `Two reports disagree about ${names.join(' and ')}. Both are shown under the evidence.`;
}

/** What a gene's sources say, in words: the phenotype as reported, or the activity score where that is all the report gives. */
export function geneValue(gene: GenomicGene): string | null {
  if (gene.status !== 'resolved') return null;
  const source = gene.sources.find((item) => item.phenotype !== null || item.activityScore !== null);
  if (!source) return null;
  return source.phenotype ?? `Activity score ${source.activityScore}`;
}

/** Layer 1's one line: "Because SLCO1B1 is Decreased function in this patient's report." One clause per resolved gene the result used. */
export function becauseLine(result: Pick<GenomicCheckResult, 'genes'>, genes: readonly GenomicGene[]): string | null {
  const clauses = result.genes
    .map((name) => {
      const gene = genes.find((item) => item.gene === name);
      const value = gene ? geneValue(gene) : null;
      return value ? `${name} is ${value}` : null;
    })
    .filter((clause): clause is string => clause !== null);
  if (clauses.length === 0) return null;
  return `Because ${clauses.join(' and ')} in this patient's report.`;
}

/** Genes a medication's results name that no confirmed report includes: their card reads "Not tested". */
export function untestedGenes(profile: Pick<GenomicProfileDto, 'genes' | 'medications' | 'check'>): string[] {
  const known = new Set(profile.genes.map((gene) => gene.gene));
  const named = [...profile.medications, ...(profile.check ? [profile.check] : [])].flatMap((check) => check.results.flatMap((result) => result.genes));
  return [...new Set(named)].filter((gene) => !known.has(gene)).sort();
}
