import type { GlossaryEntry } from '../glossary';
import type { HelpArticle, HelpScreen } from '../help';

/**
 * Spec 051 slice H2: the help panel's search and its rule for questions about a patient. Pure functions over the reviewed articles and the
 * glossary: no model, no request, nothing stored. The order of results is fixed and tested (section 4). Moved here from the frontend by spec
 * 053 slice C2a, so the browser and the help lane on the server share one rule. Roles are plain strings, so either side can pass its own.
 */

/** The screen an article belongs to, from the address in view; null for a page no article is about. */
export function helpScreenOf(pathname: string): HelpScreen | null {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (path === '/workspace') return 'worklist';
  if (path === '/patients') return 'patients';
  if (path === '/patients/new') return 'new-patient';
  if (/^\/patients\/[^/]+$/.test(path)) return 'patient';
  if (path === '/reports') return 'reports';
  if (path === '/reports/upload') return 'upload';
  if (path === '/follow-ups') return 'follow-ups';
  if (path === '/settings') return 'settings';
  if (path === '/usage') return 'usage';
  return null;
}

/** An article is for a person when it is for everyone or for one of their roles (spec 051 section 2). */
export function visibleTo(article: HelpArticle, roles: readonly string[]): boolean {
  return article.roles === 'all' || article.roles.some((role) => roles.includes(role));
}

/** The articles for this screen and these roles, in the file's order. */
export function articlesFor(articles: readonly HelpArticle[], screen: HelpScreen | null, roles: readonly string[]): HelpArticle[] {
  return screen === null ? [] : articles.filter((article) => article.screens.includes(screen) && visibleTo(article, roles));
}

const MARKS = /\p{M}+/gu;
const NOT_A_WORD = /[^\p{L}\p{N}]+/gu;
/** The text without its accents: "Cómo" reads "Como". */
const withoutAccents = (text: string) => text.normalize('NFD').replace(MARKS, '');

/** Letters and digits only, lower case, accents removed, one space between words: "Cómo  AÑADIR" reads "como anadir". */
export function normalizeHelpText(text: string): string {
  return withoutAccents(text).toLowerCase().replace(NOT_A_WORD, ' ').trim();
}

/** Words that carry no topic, in English and Spanish, as normalized. */
const FILLER_EN = 'a an the and or of to in on for at by with is are be do does did how what why when where which who can i my me it this that there here';
const FILLER_ES = 'el la los las un una y o de del en para por con es son que como cual quien donde cuando mi lo esto eso';
const FILLER_WORDS = new Set(`${FILLER_EN} ${FILLER_ES}`.split(' '));

/** A word as compared: a plural "s" is dropped from words longer than three letters, so "results" finds "result". */
const stem = (word: string) => (word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word);
const wordsOf = (text: string) => new Set(normalizeHelpText(text).split(' ').filter(Boolean).map(stem));

/** The words of a question that can match: not filler, stemmed, each once. */
export function queryWords(question: string): string[] {
  const words = normalizeHelpText(question).split(' ');
  const kept = words.filter((word) => word.length > 0 && !FILLER_WORDS.has(word));
  return [...new Set(kept.map(stem))];
}

export type HelpHit = { kind: 'article'; article: HelpArticle } | { kind: 'word'; entry: GlossaryEntry };
export interface HelpResults {
  hits: HelpHit[];
  /** True when the best hit matches fewer than half the question's words: the panel says so and shows the closest three (section 4). */
  weak: boolean;
}

interface Scored {
  hit: HelpHit;
  title: string;
  score: number;
  matched: number;
  own: boolean;
}

function score(words: string[], strong: Set<string>, body: Set<string>): { score: number; matched: number } {
  let total = 0;
  let matched = 0;
  for (const word of words) {
    if (strong.has(word)) {
      total += 2;
      matched += 1;
    } else if (body.has(word)) {
      total += 1;
      matched += 1;
    }
  }
  return { score: total, matched };
}

/**
 * Every article the person may read and every glossary entry, scored: 2 for a word in the title or keywords (the term or its aliases for a
 * word), 1 for a word only in the body. Ordered by score, then the screen's own articles first, then by title. Nothing matching gives no hits.
 */
export function searchHelp(asked: string, articles: readonly HelpArticle[], glossary: readonly GlossaryEntry[], screen: HelpScreen | null, roles: readonly string[]): HelpResults {
  const words = queryWords(asked);
  if (words.length === 0) return { hits: [], weak: false };
  const scored: Scored[] = [];
  for (const article of articles) {
    if (!visibleTo(article, roles)) continue;
    const result = score(words, wordsOf([article.title, ...article.keywords].join(' ')), wordsOf(article.body.join(' ')));
    if (result.score > 0) scored.push({ hit: { kind: 'article', article }, title: article.title, own: screen !== null && article.screens.includes(screen), ...result });
  }
  for (const entry of glossary) {
    const result = score(words, wordsOf([entry.term, ...entry.aliases].join(' ')), wordsOf(entry.body));
    if (result.score > 0) scored.push({ hit: { kind: 'word', entry }, title: entry.term, own: false, ...result });
  }
  scored.sort((a, b) => b.score - a.score || Number(b.own) - Number(a.own) || a.title.localeCompare(b.title, 'en'));
  const best = scored[0];
  const weak = !best || best.matched * 2 < words.length;
  return { hits: (weak ? scored.slice(0, 3) : scored).map((item) => item.hit), weak };
}

/** Words that point at a particular person, in English and Spanish, as normalized. */
const PATIENT_WORDS = new Set(['patient', 'patients', 'paciente', 'pacientes', 'she', 'he', 'her', 'him', 'his', 'hers', 'ella', 'su']);
/** Words that ask what to do clinically, in English and Spanish, as normalized. How-to words such as add, record or open are not here. */
const CLINICAL_WORDS = new Set([
  'dose',
  'doses',
  'dosing',
  'dosage',
  'take',
  'taking',
  'give',
  'giving',
  'prescribe',
  'prescribing',
  'switch',
  'avoid',
  'increase',
  'decrease',
  'reduce',
  'recommend',
  'recommended',
  'dosis',
  'tomar',
  'toma',
  'dar',
  'recetar',
  'evitar',
  'cambiar',
  'aumentar',
  'reducir',
  'recomienda',
  'recomendado',
]);

/**
 * True when a question is about a patient (spec 051 section 5, H-D6): it names a synthetic patient label, a star allele or an activity score,
 * or puts a word for a person beside a word that asks what to do clinically. The panel then searches nothing and says why. It may refuse a
 * general question; it is never the only safeguard, because no article speaks about a patient.
 */
export function isPatientQuestion(question: string): boolean {
  const text = withoutAccents(question).toLowerCase();
  if (/\bsyn-[a-z0-9][a-z0-9-]*/.test(text)) return true;
  if (/\*\s?\d+/.test(text)) return true;
  if (/\bactivity score\s*(of\s*)?\d/.test(text) || /\bpuntuacion de actividad\s*(de\s*)?\d/.test(text)) return true;
  const words = normalizeHelpText(text).split(' ');
  return words.some((word) => PATIENT_WORDS.has(word)) && words.some((word) => CLINICAL_WORDS.has(word));
}
