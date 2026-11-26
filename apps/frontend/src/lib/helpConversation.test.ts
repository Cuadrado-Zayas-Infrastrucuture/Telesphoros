import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GLOSSARY_EN, HELP_EN } from '@telesphoros/help-content';
import { answerFor, answerForHit, MORE_HITS, type HelpAnswer } from './helpConversation';
import { searchHelp, type HelpHit } from './helpSearch';

// Spec 053 slice C1: Help's answer to one question. Hand-written expectations from spec 051 sections 4 and 5 and the C1 plan, section 2,
// against the real draft articles. The engine is the real one, wrapped so a test can see whether it ran.
vi.mock('./helpSearch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./helpSearch')>();
  return { ...actual, searchHelp: vi.fn(actual.searchHelp) };
});

const CORPUS = { articles: HELP_EN.articles, glossary: GLOSSARY_EN };
const PATIENT = '/patients/0f8fad5b-d9cb-469f-a165-70867728950e';
const idOf = (hit: HelpHit) => (hit.kind === 'article' ? hit.article.id : `word:${hit.entry.id}`);
function shownIn(answer: HelpAnswer): HelpHit[] {
  if (answer.kind === 'quote') return [answer.hit, ...answer.more];
  if (answer.kind === 'closest') return answer.hits;
  return [];
}

beforeEach(() => {
  vi.mocked(searchHelp).mockClear();
});

describe('a question about a patient', () => {
  it('is refused before any search, with the way to the results on a patient page', () => {
    // "patient" alone would find an article: the refusal must win before the search is even run.
    expect(answerFor('can my patient take clopidogrel', CORPUS, PATIENT, ['clinician'])).toEqual({ kind: 'refusal', patientLink: `${PATIENT}#patient-results` });
    expect(searchHelp).not.toHaveBeenCalled();
  });

  it('is refused on any other page, without a link to a patient', () => {
    expect(answerFor('dose for SYN-0042', CORPUS, '/workspace', ['clinician'])).toEqual({ kind: 'refusal', patientLink: null });
    expect(answerFor('what about *2/*17', CORPUS, '/workspace', ['clinician'])).toEqual({ kind: 'refusal', patientLink: null });
    expect(searchHelp).not.toHaveBeenCalled();
  });
});

describe('a question the articles answer', () => {
  it('quotes the best article, with up to two more under it', () => {
    const answer = answerFor('what is a held result', CORPUS, '/workspace', ['reader']);
    expect(answer.kind).toBe('quote');
    if (answer.kind !== 'quote') return;
    expect(idOf(answer.hit)).toBe('held-results');
    expect(answer.more.length).toBeGreaterThan(0);
    expect(answer.more.length).toBeLessThanOrEqual(MORE_HITS);
    expect(answer.more.map(idOf)).not.toContain('held-results');
  });

  it('quotes a glossary word when it is the best match', () => {
    const answer = answerFor('phenotype', CORPUS, '/workspace', ['reader']);
    expect(answer.kind === 'quote' && idOf(answer.hit)).toBe('word:phenotype');
  });

  it.each(['what is a held result', 'how do I add a patient', 'what does phenotype mean'])('answers "%s", and does not refuse it (spec 051 section 5)', (question) => {
    expect(answerFor(question, CORPUS, PATIENT, ['clinician']).kind).toBe('quote');
    expect(searchHelp).toHaveBeenCalledTimes(1);
  });

  it('never quotes an article the person may not read', () => {
    const answer = answerFor('usage page counts', CORPUS, '/usage', ['reader']);
    expect(shownIn(answer).map(idOf)).not.toContain('the-usage-page');
  });
});

describe('a question nothing answers exactly', () => {
  it('offers the first three articles for this page when nothing matches at all', () => {
    const answer = answerFor('zebra', CORPUS, '/workspace', ['reader']);
    expect(answer.kind).toBe('closest');
    if (answer.kind !== 'closest') return;
    expect(answer.hits.length).toBeGreaterThan(0);
    expect(answer.hits.length).toBeLessThanOrEqual(3);
    for (const hit of answer.hits) expect(hit.kind === 'article' && hit.article.screens).toContain('worklist');
  });

  it('treats a question of filler words only the same way', () => {
    expect(answerFor('how do I', CORPUS, '/workspace', ['reader']).kind).toBe('closest');
  });

  it('offers nothing to open on a page no article is about, rather than guessing', () => {
    expect(answerFor('zebra', CORPUS, '/somewhere-else', ['reader'])).toEqual({ kind: 'closest', hits: [] });
  });
});

it('quotes a chosen article whole, with nothing under it (plan C1-D1)', () => {
  const hit: HelpHit = { kind: 'article', article: HELP_EN.articles.find((item) => item.id === 'follow-ups')! };
  expect(answerForHit(hit)).toEqual({ kind: 'quote', hit, more: [] });
});
