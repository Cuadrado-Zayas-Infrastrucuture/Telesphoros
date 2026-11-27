import type { GlossaryEntry } from '../glossary';
import type { HelpArticle } from '../help';
import { articlesFor, helpScreenOf, isPatientQuestion, searchHelp, withoutTrailingSlashes, type HelpHit } from './search';

/**
 * Spec 053 slice C1: Help's answer to one question, as data. This is the one place the order of the rules lives: the refusal for a question
 * about a patient comes first and is decided before any search (spec 051 section 5, H-D6); only then are the reviewed articles and the
 * glossary searched (section 4). No model, no request, nothing stored. C2's model path falls back to this answer.
 */
export type HelpAnswer =
  /** The fixed refusal sentence; on a patient's page, the link to that patient's results. */
  | { kind: 'refusal'; patientLink: string | null }
  /** The best article or glossary word, quoted whole, and up to two more hits to open next. */
  | { kind: 'quote'; hit: HelpHit; more: HelpHit[] }
  /** No article answers exactly: the closest three, or this page's first three when nothing matches at all. */
  | { kind: 'closest'; hits: HelpHit[] };

export interface HelpCorpus {
  articles: readonly HelpArticle[];
  glossary: readonly GlossaryEntry[];
}

/** How many more hits a quoted answer offers under it (plan C1, section 2). */
export const MORE_HITS = 2;

const asHit = (article: HelpArticle): HelpHit => ({ kind: 'article', article });

export function answerFor(question: string, corpus: HelpCorpus, pathname: string, roles: readonly string[]): HelpAnswer {
  const screen = helpScreenOf(pathname);
  if (isPatientQuestion(question)) return { kind: 'refusal', patientLink: screen === 'patient' ? `${withoutTrailingSlashes(pathname)}#patient-results` : null };
  const results = searchHelp(question, corpus.articles, corpus.glossary, screen, roles);
  if (results.hits.length === 0) return { kind: 'closest', hits: articlesFor(corpus.articles, screen, roles).slice(0, 3).map(asHit) };
  if (results.weak) return { kind: 'closest', hits: results.hits };
  const [best, ...rest] = results.hits;
  return { kind: 'quote', hit: best, more: rest.slice(0, MORE_HITS) };
}

/** The answer for an article or word the person chose from a list: it is quoted whole, with nothing under it. */
export const answerForHit = (hit: HelpHit): HelpAnswer => ({ kind: 'quote', hit, more: [] });

/** A stable key for a hit in a list. */
export const hitKey = (hit: HelpHit) => (hit.kind === 'article' ? `article-${hit.article.id}` : `word-${hit.entry.id}`);
