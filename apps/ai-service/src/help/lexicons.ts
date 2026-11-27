import { HELP_ROLES, HELP_SCREENS, queryWords, type GlossaryEntry, type HelpArticle } from '@telesphoros/help-content';
import { hashBytes } from '../evidence';

/**
 * The words the help lane's checks read (help-lane.md FR-H3). HC3's meaning-carrying words are built from the corpus itself, so a new article
 * extends them; HC4's gene symbols are a fixed list. Both are digested, so a change re-runs the evaluation gate.
 */

/** Words that name a status or outcome on the screens, beyond the corpus's own titles and keywords. */
export const STATUS_WORDS: readonly string[] = ['held', 'hold', 'overdue', 'due', 'signed', 'draft', 'withdrawn', 'current', 'refused', 'synthetic', 'switched', 'disabled'];

/** HC3: the meaning-carrying words, in `queryWords` form (no filler, plural "s" dropped), from titles, keywords, glossary terms, roles and screens. */
export function meaningWords(articles: readonly HelpArticle[], glossary: readonly GlossaryEntry[]): ReadonlySet<string> {
  const out = new Set<string>(STATUS_WORDS.flatMap(queryWords));
  for (const article of articles) for (const text of [article.title, ...article.keywords]) for (const word of queryWords(text)) out.add(word);
  for (const entry of glossary) for (const text of [entry.term, ...entry.aliases]) for (const word of queryWords(text)) out.add(word);
  for (const text of [...HELP_ROLES, ...Object.keys(HELP_SCREENS)]) for (const word of queryWords(text)) out.add(word);
  return out;
}

/** HC4: gene symbols an answer about the product never names. The CPIC genes, the synthetic genes, and the CYP and HLA forms by shape. */
export const GENE_SYMBOLS: readonly string[] = [
  'ABCG2',
  'BCHE',
  'CACNA1S',
  'CFTR',
  'DPYD',
  'G6PD',
  'IFNL3',
  'MT-RNR1',
  'NAT2',
  'NUDT15',
  'POLG',
  'RYR1',
  'SLCO1B1',
  'TPMT',
  'UGT1A1',
  'VKORC1',
];
/** A gene symbol by its shape: CYP2C19 and the like, HLA-B and the like, and the synthetic GENEA to GENEZ. Case-sensitive, as symbols are written. */
export const GENE_SHAPE = /\b(?:CYP\d[A-Z0-9]*|HLA-[A-Z][A-Z0-9]*|GENE[A-Z])\b/;

export const helpLexiconDigest = (articles: readonly HelpArticle[], glossary: readonly GlossaryEntry[]): string =>
  hashBytes(JSON.stringify({ meaning: [...meaningWords(articles, glossary)].sort(), genes: [...GENE_SYMBOLS].sort(), shape: GENE_SHAPE.source }));
