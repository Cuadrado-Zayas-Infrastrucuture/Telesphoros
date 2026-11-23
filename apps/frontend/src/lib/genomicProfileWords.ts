import { REASON_MESSAGES, REVIEWER_ACTIONS, RETIRED_REASON_CODES, type ReasonCode } from '@telesphoros/cpic-schema/vocabulary';
import type { GlossaryEntry } from '@telesphoros/help-content';
import type { ContextNotice, GenomicCheck, GenomicCheckResult, GenomicCheckWord, GenomicGene, GenomicProfileDto } from '@telesphoros/shared-types';

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

/**
 * Layer 1's one line, in parts so each value can open its glossary entry: "Because SLCO1B1 is Decreased Function in this patient's report."
 * One clause per resolved gene the result used; none when no gene has a value.
 */
export function becauseClauses(result: Pick<GenomicCheckResult, 'genes'>, genes: readonly GenomicGene[]): Array<{ gene: string; value: string }> {
  return result.genes
    .map((name) => {
      const gene = genes.find((item) => item.gene === name);
      const value = gene ? geneValue(gene) : null;
      return value ? { gene: name, value } : null;
    })
    .filter((clause): clause is { gene: string; value: string } => clause !== null);
}

/** Genes a medication's results name that no confirmed report includes: their card reads "Not tested". */
export function untestedGenes(profile: Pick<GenomicProfileDto, 'genes' | 'medications' | 'check'>): string[] {
  const known = new Set(profile.genes.map((gene) => gene.gene));
  const named = [...profile.medications, ...(profile.check ? [profile.check] : [])].flatMap((check) => check.results.flatMap((result) => result.genes));
  return [...new Set(named)].filter((gene) => !known.has(gene)).sort();
}

// The ⓘ "About this check", as spec 045 D8 gives it.
const ABOUT_SENTENCES = [
  'This check names medications the FDA lists as strong or moderate inhibitors or inducers of the gene.',
  'The list is not exhaustive, and stopped medications and other causes, such as liver disease, are not checked.',
];

/**
 * Spec 045 slice N3: the words of the notice that a current medication can change a gene's effect (phenoconversion, step 1). **Draft
 * wording, from plan-slice-n3.md, awaiting the founders' signature (P-D6).** Everyday verbs on the row ("lowers", "raises"), the source's
 * own terms in the evidence (N3-D3). None of it says "safe", "no interaction", "not affected" or "none" (PN-5).
 */
export const NOTICE_WORDS = {
  lead: 'A medication this patient takes can change this.',
  rowEnd: 'The guidance above is based on the genes alone and does not take this into account.',
  cardEnd: 'The result above is from the genes alone and does not take this into account.',
  startNotRecorded: 'Its start date is not recorded.',
  evidenceHeading: 'Medications that can change this result',
  openSource: 'Open the source',
  coverageLoaded: "Medications that can change a gene's effect are checked against the FDA list of strong and moderate ones. That list is not complete.",
  coverageNotLoaded: "Medications that can change a gene's effect are not checked yet.",
  aboutLabel: 'About this check',
  about: ABOUT_SENTENCES.join(' '),
} as const;

const NOTICE_VERBS: Readonly<Record<ContextNotice['effect'], string>> = { inhibitor: 'lowers', inducer: 'raises' };
const NOTICE_ADVERBS: Readonly<Record<ContextNotice['strength'], string>> = { strong: 'strongly', moderate: 'moderately' };

function sentenceStart(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * One notice in everyday words: "Paroxetine, which this patient takes, strongly lowers CYP2D6 activity." then what the guidance (on a row)
 * or the result (on a gene's card) does not account for. A drug that is its own modifier reads "Fluvoxamine itself ..." (N2 rule 2).
 */
export function noticeSentence(notice: ContextNotice, place: 'row' | 'card', checkRxcui?: string): string {
  const name = sentenceStart(notice.medication.name);
  const subject = notice.medication.rxcui === checkRxcui ? `${name} itself` : `${name}, which this patient takes,`;
  const sentences = [`${subject} ${NOTICE_ADVERBS[notice.strength]} ${NOTICE_VERBS[notice.effect]} ${notice.gene} activity.`];
  if (!notice.medication.startRecorded) sentences.push(NOTICE_WORDS.startNotRecorded);
  sentences.push(place === 'row' ? NOTICE_WORDS.rowEnd : NOTICE_WORDS.cardEnd);
  return sentences.join(' ');
}

/** The evidence: the source's own terms, "Paroxetine: listed as a strong inhibitor of CYP2D6." */
export function noticeTerm(notice: ContextNotice): string {
  return `${sentenceStart(notice.medication.name)}: listed as a ${notice.strength} ${notice.effect} of ${notice.gene}.`;
}

/** Where the list says it (PN-7): "Source: [source], version [v], [table], row [r]." */
export function noticeSourceLine(notice: ContextNotice): string {
  const { source, sourceVersion, table, row } = notice.source;
  return `Source: ${[source, `version ${sourceVersion}`, table, row === null ? null : `row ${row}`].filter(Boolean).join(', ')}.`;
}

/** The line always shown under "Current medications, checked" (N3-D2): what the check covers, or that it is not running yet (PN-6). */
export function coverageLine(profile: Pick<GenomicProfileDto, 'modifierLists'>): string {
  return profile.modifierLists?.loaded === true ? NOTICE_WORDS.coverageLoaded : NOTICE_WORDS.coverageNotLoaded;
}

/**
 * Spec 044 slice B part 2: the glossary drawer's own words (draft, G3). The entries themselves are in `packages/help-content`, shared with
 * the help assistant.
 */
export const GLOSSARY_WORDS = {
  listTitle: 'Words used here',
  allTerms: 'All terms',
  close: 'Close the glossary',
  draft: 'Draft: not yet reviewed by a pharmacist.',
  phenoconversion: 'What is phenoconversion?',
} as const;

/** The foot of an entry: who reviewed and signed it and when, or that it is a draft (B2-D2). */
export function glossaryFoot(entry: Pick<GlossaryEntry, 'status' | 'signedBy'>): string {
  if (entry.status !== 'signed') return GLOSSARY_WORDS.draft;
  return `Reviewed and signed by ${entry.signedBy.map((signer) => `${signer.name}, ${signer.role}, on ${signer.date}`).join('; ')}.`;
}
