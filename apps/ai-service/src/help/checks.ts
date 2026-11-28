import { normalizeHelpText, queryWords, visibleTo, type HelpArticle } from '@telesphoros/help-content';
import { BUNDLED_DRUG_LIST } from '@telesphoros/shared-types/drug-list-data';
import { signedForModel, type HelpReply } from './contracts';
import { GENE_SHAPE, GENE_SYMBOLS } from './lexicons';

/**
 * The help lane's checks (help-lane.md FR-H3), each a pure function of the reply and what was sent. A check returns its hold codes, or none.
 * Any hold on any sentence withholds the whole model answer, and the curated answer shows (HL-D1). The evaluation gate (C2c) has a broken
 * copy of each, so a check that stops working turns the gate red.
 */
export interface HelpCheckContext {
  /** The articles that were in the prompt. */
  sent: readonly HelpArticle[];
  roles: readonly string[];
  /** HC3's meaning-carrying words (`meaningWords`). */
  meaning: ReadonlySet<string>;
  /** Only the evaluation runner passes true, for its fixture corpus (C2-D1). */
  allowTestSigners?: boolean;
}
export type HelpCheck = (reply: HelpReply, context: HelpCheckContext) => string[];
type Sentence = HelpReply['sentences'][number];

const each = (reply: HelpReply, hold: (sentence: Sentence) => string | null): string[] => reply.sentences.map(hold).filter((code): code is string => code !== null);

/** HC1: the cited passage is a byte-exact span of one paragraph of the cited article. */
export const hc1: HelpCheck = (reply, { sent }) => {
  return each(reply, (s) => {
    const article = sent.find((a) => a.id === s.articleId);
    return article && !article.body.some((paragraph) => paragraph.includes(s.passage)) ? 'HC1_PASSAGE_NOT_IN_ARTICLE' : null;
  });
};

/** HC2: the cited article was in the prompt, is signed for the model, and is visible to these roles. */
export const hc2: HelpCheck = (reply, { sent, roles, allowTestSigners }) => {
  return each(reply, (s) => {
    const article = sent.find((a) => a.id === s.articleId);
    if (!article) return 'HC2_ARTICLE_NOT_SENT';
    if (!signedForModel(article, allowTestSigners)) return 'HC2_ARTICLE_NOT_SIGNED';
    return visibleTo(article, roles) ? null : 'HC2_ARTICLE_NOT_VISIBLE';
  });
};

const numerals = (text: string): string[] => text.match(/\d+/g) ?? [];
/** HC3 (HC-D5): every meaning-carrying word of the sentence, and every number, is in its cited passage. */
export const hc3: HelpCheck = (reply, { meaning }) => {
  return reply.sentences.flatMap((s) => {
    const passage = new Set(queryWords(s.passage));
    const holds: string[] = [];
    if (queryWords(s.text).some((word) => meaning.has(word) && !passage.has(word))) holds.push('HC3_MEANING_NOT_IN_PASSAGE');
    const passageNumbers = new Set(numerals(s.passage));
    if (numerals(s.text).some((n) => !passageNumbers.has(n))) holds.push('HC3_NUMBER_NOT_IN_PASSAGE');
    return holds;
  });
};

let drugNames: readonly string[] | null | undefined;
/** The bundled drug list's names, normalized as Help normalizes text; null when no verified list is bundled. Built once. */
function bundledDrugNames(): readonly string[] | null {
  if (drugNames === undefined) drugNames = BUNDLED_DRUG_LIST ? [...new Set(BUNDLED_DRUG_LIST.entries.map((e) => normalizeHelpText(e.name)).filter((n) => n !== ''))] : null;
  return drugNames;
}
const PATIENT_LABEL = /\bsyn-[a-z0-9]/i;
const STAR_ALLELE = /\*\s?\d/;
const ACTIVITY_SCORE = /\bactivity score\s*(?:of\s*)?\d/i;
const GENE_WORDS = new Set(GENE_SYMBOLS);
/**
 * HC4: a sentence never names a patient label, a star allele, an activity score with its number, a gene symbol or a drug from the bundled
 * list. With no verified drug list, every answer is held. The question-shaped rule (a patient word beside a clinical word) is not applied to
 * the answer: the articles themselves say "on a patient's page … before prescribing", and that rule has already run on the question.
 */
export const hc4: HelpCheck = (reply) => {
  const names = bundledDrugNames();
  if (names === null) return reply.sentences.length > 0 ? ['HC4_NO_DRUG_LIST'] : [];
  return each(reply, (s) => {
    if (PATIENT_LABEL.test(s.text) || STAR_ALLELE.test(s.text) || ACTIVITY_SCORE.test(s.text)) return 'HC4_ABOUT_A_PATIENT';
    if (GENE_SHAPE.test(s.text) || s.text.split(/[^A-Za-z0-9-]+/).some((token) => GENE_WORDS.has(token))) return 'HC4_GENE';
    const padded = ` ${normalizeHelpText(s.text)} `;
    return names.some((name) => padded.includes(` ${name} `)) ? 'HC4_DRUG' : null;
  });
};

/** HC5: the rule every article follows (packages/help-content's test): never "safe", "no interaction", "not affected" or "none". */
export const REASSURES = /\bsafe\b|no interaction|not affected|\bnone\b/i;
export const hc5: HelpCheck = (reply) => each(reply, (s) => (REASSURES.test(s.text) ? 'HC5_REASSURES' : null));

const MARKUP = /<[a-z/!]|https?:\/\/|www\.|```|\]\(/i;
const ABOUT_YOUR_PATIENT = /\byour patients?\b/i;
const ABOUT_ITSELF = /\b(?:language model|as an ai|my instructions|the instructions|system prompt|the prompt|I was told|I cannot|I can't)\b/i;
/** HC6: an answer that is not out of scope says something; no sentence has markup or a link, addresses the reader's patient, or talks about the model. */
export const hc6: HelpCheck = (reply) => {
  if (!reply.outOfScope && reply.sentences.length === 0) return ['HC6_EMPTY'];
  return each(reply, (s) => {
    if (MARKUP.test(s.text)) return 'HC6_MARKUP';
    if (ABOUT_YOUR_PATIENT.test(s.text)) return 'HC6_ABOUT_YOUR_PATIENT';
    return ABOUT_ITSELF.test(s.text) ? 'HC6_ABOUT_THE_MODEL' : null;
  });
};

export const HELP_CHECK_IDS = ['HC1', 'HC2', 'HC3', 'HC4', 'HC5', 'HC6'] as const;
export type HelpCheckId = (typeof HELP_CHECK_IDS)[number];
export const HELP_CHECKS: Readonly<Record<HelpCheckId, HelpCheck>> = { HC1: hc1, HC2: hc2, HC3: hc3, HC4: hc4, HC5: hc5, HC6: hc6 };

/** Every check, in order; the hold codes, each once. The serving path reaches the checks only through this function (R2). */
export function runHelpChecks(reply: HelpReply, context: HelpCheckContext, checks: Readonly<Record<HelpCheckId, HelpCheck>> = HELP_CHECKS): string[] {
  return [...new Set(HELP_CHECK_IDS.flatMap((id) => checks[id](reply, context)))];
}

/** The model's own refusal check (HL-D3): it can only add a refusal, never release what the rule refused. */
export const isOutOfScope = (reply: HelpReply): boolean => reply.outOfScope;
