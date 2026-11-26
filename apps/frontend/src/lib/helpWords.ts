import type { HelpArticle } from '@telesphoros/help-content';
import { glossaryFoot } from './genomicProfileWords';

/**
 * The help panel's own fixed words (spec 051 slice H2; spec 053 slice C1, the conversation). The articles and the refusal sentence are in
 * packages/help-content, to be signed.
 */
export const HELP_WORDS = {
  button: 'Help',
  title: 'Help',
  close: 'Close help',
  intro: 'Ask how something in the app works.',
  ask: 'Ask Help',
  send: 'Send',
  conversation: 'Conversation with Help',
  you: 'You',
  helpSays: 'Help',
  from: 'From',
  alsoInHelp: 'Also in Help',
  limit: 'Earlier messages are removed after 20.',
  forThisPage: 'For this page',
  nothingForThisPage: 'No article is written for this page yet. Ask a question below to search them all.',
  weak: 'No article answers that exactly. These are the closest:',
  tryOther: 'Try other words, for example "held result" or "add a patient".',
  word: 'Word',
  patientResults: "Open this patient's results",
  /** Shown only if the refusal sentence is missing from the content, which its test forbids for English. */
  refusalFallback: 'Help does not answer questions about a patient.',
} as const;

/** The foot of an article: who signed it and when, or that it is a draft, in the glossary's own words (spec 051 H-D1, spec 044 B2-D2). */
export function helpFoot(item: Pick<HelpArticle, 'status' | 'signedBy'>): string {
  return glossaryFoot(item);
}
