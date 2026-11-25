import type { GlossaryEntry, HelpArticle, HelpScreen } from '@telesphoros/help-content';
import { normalizeHelpText } from './patientRefusal';

export const WEAK_MATCH_MESSAGE = 'No article answers that exactly. These are the closest:';

const FILLER_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'can',
  'do',
  'does',
  'for',
  'from',
  'how',
  'i',
  'in',
  'is',
  'it',
  'me',
  'my',
  'of',
  'on',
  'or',
  'should',
  'that',
  'the',
  'this',
  'to',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'with',
  'would',
  'you',
  'your',
  'el',
  'la',
  'los',
  'las',
  'un',
  'una',
  'de',
  'del',
  'en',
  'y',
  'o',
  'es',
  'son',
  'como',
  'que',
  'cual',
  'donde',
  'cuando',
  'por',
  'para',
  'con',
  'se',
  'su',
  'al',
]);

const TITLE_OR_KEYWORD_WEIGHT = 3;
const BODY_WEIGHT = 1;
const WEAK_RESULT_LIMIT = 3;

export type HelpSearchHit =
  | {
      kind: 'article';
      id: string;
      title: string;
      article: HelpArticle;
      score: number;
      matchedWords: number;
      onCurrentScreen: boolean;
    }
  | {
      kind: 'glossary';
      id: string;
      title: string;
      entry: GlossaryEntry;
      score: number;
      matchedWords: number;
      onCurrentScreen: false;
    };

export interface HelpSearchResult {
  weak: boolean;
  results: HelpSearchHit[];
}

function tokenize(text: string): string[] {
  return normalizeHelpText(text)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

function queryTerms(rawQuery: string): string[] {
  const unique = new Set<string>();
  for (const token of tokenize(rawQuery)) {
    if (!FILLER_WORDS.has(token)) unique.add(token);
  }
  return [...unique];
}

function tokensContainTerm(tokens: readonly string[], term: string): boolean {
  for (const token of tokens) {
    if (token === term) return true;
    if (term.length >= 4 && token.startsWith(term)) return true;
    if (token.length >= 4 && term.startsWith(token)) return true;
  }
  return false;
}

function scoreTokens(terms: readonly string[], highTokens: readonly string[], bodyTokens: readonly string[]): { score: number; matchedWords: number } {
  let score = 0;
  let matchedWords = 0;
  for (const term of terms) {
    if (tokensContainTerm(highTokens, term)) {
      score += TITLE_OR_KEYWORD_WEIGHT;
      matchedWords += 1;
    } else if (tokensContainTerm(bodyTokens, term)) {
      score += BODY_WEIGHT;
      matchedWords += 1;
    }
  }
  return { score, matchedWords };
}

function compareHits(a: HelpSearchHit, b: HelpSearchHit): number {
  if (b.score !== a.score) return b.score - a.score;
  if (a.onCurrentScreen !== b.onCurrentScreen) return a.onCurrentScreen ? -1 : 1;
  const byTitle = a.title.localeCompare(b.title, 'en');
  if (byTitle !== 0) return byTitle;
  return a.id.localeCompare(b.id, 'en');
}

/**
 * Spec 051 section 4: deterministic, model-free search over role-filtered articles and glossary entries.
 * Title and keyword matches outrank body matches. Ties break by current screen first, then alphabetically.
 * When the best hit matches fewer than half the query's non-filler words, `weak` is true and at most 3 results return.
 */
export function searchHelp(rawQuery: string, articles: readonly HelpArticle[], glossary: readonly GlossaryEntry[], currentScreen: HelpScreen | null): HelpSearchResult {
  const terms = queryTerms(rawQuery);
  if (terms.length === 0) return { weak: true, results: [] };

  const hits: HelpSearchHit[] = [];

  for (const article of articles) {
    const highTokens = [...tokenize(article.title), ...article.keywords.flatMap(tokenize)];
    const bodyTokens = article.body.flatMap(tokenize);
    const { score, matchedWords } = scoreTokens(terms, highTokens, bodyTokens);
    if (matchedWords > 0) {
      hits.push({
        kind: 'article',
        id: article.id,
        title: article.title,
        article,
        score,
        matchedWords,
        onCurrentScreen: currentScreen !== null && article.screens.includes(currentScreen),
      });
    }
  }

  for (const entry of glossary) {
    const highTokens = [...tokenize(entry.term), ...entry.aliases.flatMap(tokenize)];
    const bodyTokens = tokenize(entry.body);
    const { score, matchedWords } = scoreTokens(terms, highTokens, bodyTokens);
    if (matchedWords > 0) {
      hits.push({
        kind: 'glossary',
        id: `glossary:${entry.id}`,
        title: entry.term,
        entry,
        score,
        matchedWords,
        onCurrentScreen: false,
      });
    }
  }

  hits.sort(compareHits);

  const best = hits[0];
  const weak = !best || best.matchedWords < terms.length / 2;
  return {
    weak,
    results: weak ? hits.slice(0, WEAK_RESULT_LIMIT) : hits,
  };
}
