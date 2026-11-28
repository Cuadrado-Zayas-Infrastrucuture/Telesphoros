import { describe, expect, test } from 'vitest';
import { HELP_ROLES } from '@telesphoros/help-content';
import { HELP_CHECK_IDS, HELP_CHECKS, runHelpChecks, type HelpCheckContext, type HelpCheckId } from '../src/help/checks';
import { helpReplySchema, signedForModel, type HelpReply } from '../src/help/contracts';
import { meaningWords } from '../src/help/lexicons';
import { articleOf, sentencesOf, TEST_CORPUS } from './helpers/help-corpus';

// Spec 053 slice C2b, help-lane.md FR-H3: the checks. Hand-written seeded wrong answers against real article text, each held by the check
// named for it; a correct answer passes; a broken copy of each check lets its wrong answer through.
const HELD = articleOf('held-results');
const PASSAGE = 'A held result shows no guidance.';
const context = (extra: Partial<HelpCheckContext> = {}): HelpCheckContext => ({
  sent: [HELD, articleOf('the-worklist')],
  roles: ['reader'],
  meaning: meaningWords(TEST_CORPUS.articles, TEST_CORPUS.glossary),
  allowTestSigners: true,
  ...extra,
});
const reply = (text: string, passage = PASSAGE, articleId = 'held-results'): HelpReply => helpReplySchema.parse({ outOfScope: false, sentences: [{ text, articleId, passage }] });

const CORRECT = reply('A held result shows no guidance.');
const WRONG: ReadonlyArray<{ kind: string; reply: HelpReply; check: HelpCheckId; code: string }> = [
  {
    kind: 'passage not in the article',
    reply: reply('A held result shows no guidance.', 'A held result shows no guidance at all.'),
    check: 'HC1',
    code: 'HC1_PASSAGE_NOT_IN_ARTICLE',
  },
  { kind: 'article not sent', reply: reply('Policies are listed.', 'Policies are listed.', 'policies'), check: 'HC2', code: 'HC2_ARTICLE_NOT_SENT' },
  { kind: 'invented feature', reply: reply('A held result shows no guidance on the usage page.'), check: 'HC3', code: 'HC3_MEANING_NOT_IN_PASSAGE' },
  { kind: 'wrong role', reply: reply('A held result shows no guidance to an admin.'), check: 'HC3', code: 'HC3_MEANING_NOT_IN_PASSAGE' },
  { kind: 'changed number', reply: reply('A held result shows no guidance for 3 days.'), check: 'HC3', code: 'HC3_NUMBER_NOT_IN_PASSAGE' },
  { kind: 'a drug named', reply: reply('A held result for clopidogrel shows no guidance.'), check: 'HC4', code: 'HC4_DRUG' },
  { kind: 'a gene named', reply: reply('A held CYP2C19 result shows no guidance.'), check: 'HC4', code: 'HC4_GENE' },
  { kind: 'a synthetic gene named', reply: reply('A held GENEA result shows no guidance.'), check: 'HC4', code: 'HC4_GENE' },
  { kind: 'a patient label', reply: reply('A held result for SYN-0042 shows no guidance.'), check: 'HC4', code: 'HC4_ABOUT_A_PATIENT' },
  { kind: 'a star allele', reply: reply('A held *2 result shows no guidance.'), check: 'HC4', code: 'HC4_ABOUT_A_PATIENT' },
  { kind: 'reassurance', reply: reply('A held result shows no guidance, so it is safe.'), check: 'HC5', code: 'HC5_REASSURES' },
  { kind: 'markup', reply: reply('A held result shows <b>no guidance</b>.'), check: 'HC6', code: 'HC6_MARKUP' },
  { kind: 'a link', reply: reply('A held result shows no guidance, see https://example.org.'), check: 'HC6', code: 'HC6_MARKUP' },
  { kind: 'addresses the reader about their patient', reply: reply('A held result for your patient shows no guidance.'), check: 'HC6', code: 'HC6_ABOUT_YOUR_PATIENT' },
  { kind: 'talks about the model', reply: reply('As an AI, a held result shows no guidance.'), check: 'HC6', code: 'HC6_ABOUT_THE_MODEL' },
];

describe('the help lane checks (FR-H3)', () => {
  test('a correct answer passes every check (control)', () => expect(runHelpChecks(CORRECT, context())).toEqual([]));

  test.each(WRONG)('$kind is held by $check', ({ reply: wrong, check, code }) => {
    expect(HELP_CHECKS[check](wrong, context())).toContain(code);
    expect(runHelpChecks(wrong, context())).toContain(code);
  });

  test('every check is load-bearing: a broken copy of it lets one of its wrong answers through (R2, SC-003)', () => {
    for (const id of HELP_CHECK_IDS) {
      const broken = { ...HELP_CHECKS, [id]: () => [] };
      const own = WRONG.filter((w) => w.check === id);
      expect(own.length, id).toBeGreaterThan(0);
      expect(
        own.some((w) => runHelpChecks(w.reply, context(), broken).length === 0),
        id,
      ).toBe(true);
    }
  });

  test('HC2 holds an article that is not signed, or that these roles may not read', () => {
    const draft = { ...HELD, status: 'draft' as const, signedBy: [] };
    expect(HELP_CHECKS.HC2(CORRECT, context({ sent: [draft] }))).toEqual(['HC2_ARTICLE_NOT_SIGNED']);
    expect(HELP_CHECKS.HC2(CORRECT, context({ allowTestSigners: false }))).toEqual(['HC2_ARTICLE_NOT_SIGNED']);
    const usage = articleOf('the-usage-page');
    const own = reply(sentencesOf(usage)[0], sentencesOf(usage)[0], 'the-usage-page');
    expect(HELP_CHECKS.HC2(own, context({ sent: [usage], roles: ['reader'] }))).toEqual(['HC2_ARTICLE_NOT_VISIBLE']);
    expect(HELP_CHECKS.HC2(own, context({ sent: [usage], roles: ['admin'] }))).toEqual([]);
  });

  test('HC6 holds an answer that says nothing unless it is out of scope', () => {
    expect(HELP_CHECKS.HC6({ outOfScope: false, sentences: [] }, context())).toEqual(['HC6_EMPTY']);
    expect(HELP_CHECKS.HC6({ outOfScope: true, sentences: [] }, context())).toEqual([]);
  });

  test('the corpus passes its own checks: every sentence of every article, quoted as itself, is not held (so no check withholds every answer)', () => {
    for (const article of TEST_CORPUS.articles)
      for (const sentence of sentencesOf(article)) {
        const own = reply(sentence, sentence, article.id);
        expect(runHelpChecks(own, context({ sent: [article], roles: [...HELP_ROLES] })), `${article.id}: ${sentence}`).toEqual([]);
      }
  });
});

describe('test signers (C2-D1)', () => {
  test('an item signed by the test signers counts as signed only when the caller asks for the fixtures', () => {
    expect(signedForModel(HELD, true)).toBe(true);
    expect(signedForModel(HELD)).toBe(false);
  });
  test('no product article or glossary entry names a test signer', async () => {
    const { GLOSSARY_EN, HELP_EN } = await import('@telesphoros/help-content');
    const names = [...HELP_EN.articles, ...GLOSSARY_EN].flatMap((item) => item.signedBy.map((s) => s.name));
    expect(names.filter((n) => n.toUpperCase().includes('TEST SIGNER'))).toEqual([]);
  });
});
