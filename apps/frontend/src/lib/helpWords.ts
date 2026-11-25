import type { HelpArticle } from '@telesphoros/help-content';
import { glossaryFoot } from './genomicProfileWords';

/** The help panel's own fixed words (spec 051 slice H2). The articles and the refusal sentence are in packages/help-content, to be signed. */
export const HELP_WORDS = {
  button: 'Help',
  title: 'Help',
  close: 'Close help',
  search: 'Search help',
  hint: 'Type a few words, for example "held result" or "add a patient".',
  forThisPage: 'For this page',
  nothingForThisPage: 'No article is written for this page yet. Type a few words to search them all.',
  weak: 'No article answers that exactly. These are the closest:',
  results: 'Articles',
  word: 'Word',
  back: 'Back to the articles',
  patientResults: "Open this patient's results",
  /** Shown only if the refusal sentence is missing from the content, which its test forbids for English. */
  refusalFallback: 'Help does not answer questions about a patient.',
} as const;

/** The foot of an article: who signed it and when, or that it is a draft, in the glossary's own words (spec 051 H-D1, spec 044 B2-D2). */
export function helpFoot(item: Pick<HelpArticle, 'status' | 'signedBy'>): string {
  return glossaryFoot(item);
}
