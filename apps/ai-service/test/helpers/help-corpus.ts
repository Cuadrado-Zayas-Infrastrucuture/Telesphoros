import { GLOSSARY_EN, HELP_EN, type GlossaryEntry, type HelpArticle, type HelpCorpus } from '@telesphoros/help-content';
import { TEST_SIGNERS } from '../../src/help/contracts';

// Spec 053 slice C2b: the product's articles and glossary are all drafts, and the model answers only from signed ones (HC-D4). Tests use a
// copy signed by the two test signers (C2-D1), which only a caller that passes allowTestSigners may use.
const signers = TEST_SIGNERS.map((name) => ({ name, role: 'test', date: '2026-11-27' }));
export const testSigned = <T extends HelpArticle | GlossaryEntry>(item: T): T => ({ ...item, status: 'signed', signedBy: signers }) as T;
export const TEST_CORPUS: HelpCorpus = { articles: HELP_EN.articles.map(testSigned), glossary: GLOSSARY_EN.map(testSigned) };
export const articleOf = (id: string): HelpArticle => TEST_CORPUS.articles.find((a) => a.id === id)!;
/** The sentences of an article's paragraphs, as a model would quote them. */
export const sentencesOf = (article: HelpArticle): string[] => article.body.flatMap((paragraph) => paragraph.split(/(?<=[.!?])\s+/)).filter((s) => s !== '');
