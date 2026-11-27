import { describe, expect, it } from 'vitest';
import { GLOSSARY_EN, type GlossaryEntry } from '../glossary';
import { HELP_EN, type HelpArticle } from '../help';
import { articlesFor, helpScreenOf, isPatientQuestion, normalizeHelpText, queryWords, searchHelp } from './search';

// Spec 051 slice H2: the help panel's search and its patient-question rule. Hand-written expectations; synthetic articles where the order is
// the point, so a change to the real drafts cannot hide a change to the rule.
const article = (id: string, extra: Partial<HelpArticle> = {}): HelpArticle => ({
  id,
  title: `Synthetic ${id}`,
  body: ['Synthetic paragraph.'],
  screens: ['worklist'],
  roles: 'all',
  keywords: [],
  links: [],
  status: 'draft',
  signedBy: [],
  ...extra,
});
const word = (id: string, term: string, body: string): GlossaryEntry => ({ id, term, aliases: [term], body, status: 'draft', signedBy: [] });
const ids = (results: ReturnType<typeof searchHelp>) => results.hits.map((hit) => (hit.kind === 'article' ? hit.article.id : `word:${hit.entry.id}`));

describe('the screen in view', () => {
  it('names each screen an article can be about, and no other', () => {
    expect(helpScreenOf('/workspace')).toBe('worklist');
    expect(helpScreenOf('/patients')).toBe('patients');
    expect(helpScreenOf('/patients/new')).toBe('new-patient');
    expect(helpScreenOf('/patients/0f8fad5b-d9cb-469f-a165-70867728950e')).toBe('patient');
    expect(helpScreenOf('/reports')).toBe('reports');
    expect(helpScreenOf('/reports/upload')).toBe('upload');
    expect(helpScreenOf('/follow-ups')).toBe('follow-ups');
    expect(helpScreenOf('/settings')).toBe('settings');
    expect(helpScreenOf('/usage')).toBe('usage');
    expect(helpScreenOf('/workspace/')).toBe('worklist');
    for (const other of ['/', '/signin', '/patients/a/b', '/local-workspace', '/chat']) expect(helpScreenOf(other), other).toBeNull();
  });

  it('trims any number of trailing slashes, in linear time on any address (CodeQL)', () => {
    const many = '/'.repeat(100_000);
    expect(helpScreenOf(`/workspace${many}`)).toBe('worklist');
    expect(helpScreenOf(`${many}x`)).toBeNull();
    expect(helpScreenOf(many)).toBeNull();
  });
});

describe('the articles for this screen and these roles', () => {
  it('lists only what the roles may use, in the file order', () => {
    const list = [article('one'), article('two', { roles: ['clinician'] }), article('three', { screens: ['patients'] }), article('four', { roles: ['reader', 'reviewer'] })];
    expect(articlesFor(list, 'worklist', ['reader']).map((item) => item.id)).toEqual(['one', 'four']);
    expect(articlesFor(list, 'worklist', ['clinician']).map((item) => item.id)).toEqual(['one', 'two']);
    expect(articlesFor(list, 'worklist', []).map((item) => item.id)).toEqual(['one']);
    expect(articlesFor(list, null, ['clinician'])).toEqual([]);
  });

  it('on the real drafts: a reader on the worklist is not offered follow-ups or attaching a report, a clinician is', () => {
    const reader = articlesFor(HELP_EN.articles, 'worklist', ['reader']).map((item) => item.id);
    expect(reader).toContain('held-results');
    expect(reader).not.toContain('follow-ups');
    expect(reader).not.toContain('attach-a-report');
    const clinician = articlesFor(HELP_EN.articles, 'worklist', ['clinician']).map((item) => item.id);
    expect(clinician).toEqual(expect.arrayContaining(['held-results', 'follow-ups', 'attach-a-report']));
    // An administrator sees what is for everyone and what is for administrators alone, and nothing clinical.
    const admin = articlesFor(HELP_EN.articles, 'usage', ['admin']);
    expect(admin.every((item) => item.roles === 'all' || (item.roles.length === 1 && item.roles[0] === 'admin'))).toBe(true);
    expect(admin.map((item) => item.id)).toContain('the-usage-page');
  });
});

describe('searching', () => {
  it('reads letters and digits only, without accents or letter case, and drops filler words', () => {
    expect(normalizeHelpText('  Cómo  AÑADIR un-paciente? ')).toBe('como anadir un paciente');
    expect(queryWords('How do I add a patient?')).toEqual(['add', 'patient']);
    expect(queryWords('What are the held results')).toEqual(['held', 'result']);
    expect(queryWords('how do i')).toEqual([]);
  });

  it('orders by score (title or keyword 2, body 1), then this screen first, then by title', () => {
    const list = [
      article('body-only', { title: 'Zeta', body: ['A held line.'] }),
      article('keyword', { title: 'Beta', keywords: ['held'] }),
      article('title-other-screen', { title: 'Alpha held', screens: ['reports'] }),
      article('title-this-screen', { title: 'Gamma held' }),
      article('unrelated', { title: 'Other' }),
    ];
    const results = searchHelp('held', list, [], 'worklist', ['reader']);
    expect(ids(results)).toEqual(['keyword', 'title-this-screen', 'title-other-screen', 'body-only']);
    expect(results.weak).toBe(false);
  });

  it('searches the glossary too, marked as a word, and never an article the roles exclude', () => {
    const list = [article('for-clinicians', { title: 'Phenotype for clinicians', roles: ['clinician'] })];
    const glossary = [word('phenotype', 'Phenotype', 'How well a protein is expected to work.')];
    expect(ids(searchHelp('phenotype', list, glossary, 'worklist', ['reader']))).toEqual(['word:phenotype']);
    expect(ids(searchHelp('phenotype', list, glossary, 'worklist', ['clinician']))).toEqual(['for-clinicians', 'word:phenotype']);
  });

  it('says a match is weak when the best result matches fewer than half the words, and then shows only the closest three', () => {
    const list = ['a', 'b', 'c', 'd'].map((id) => article(id, { title: `Report ${id}` }));
    const weak = searchHelp('report alpha beta gamma', list, [], 'worklist', ['reader']);
    expect(weak.weak).toBe(true);
    expect(weak.hits).toHaveLength(3);
    // control: half the words is enough
    expect(searchHelp('report alpha', list, [], 'worklist', ['reader']).weak).toBe(false);
  });

  it('finds nothing for a question of filler or of words no article has', () => {
    expect(searchHelp('how do i', [article('one')], [], 'worklist', ['reader'])).toEqual({ hits: [], weak: false });
    expect(searchHelp('zebra', [article('one')], [], 'worklist', ['reader'])).toEqual({ hits: [], weak: true });
  });

  it('finds the real drafts by the words people use', () => {
    expect(ids(searchHelp('what is a held result', HELP_EN.articles, GLOSSARY_EN, 'worklist', ['reader']))[0]).toBe('held-results');
    expect(ids(searchHelp('how do I add a patient', HELP_EN.articles, GLOSSARY_EN, 'patients', ['clinician']))[0]).toBe('find-or-add-a-patient');
    expect(ids(searchHelp('what does phenotype mean', HELP_EN.articles, GLOSSARY_EN, 'patient', ['reader']))).toContain('word:phenotype');
    expect(ids(searchHelp('how do I check a drug before prescribing', HELP_EN.articles, GLOSSARY_EN, 'patient', ['clinician']))[0]).toBe('checking-a-drug');
    expect(ids(searchHelp('how do I change the theme', HELP_EN.articles, GLOSSARY_EN, 'settings', ['reader']))[0]).toBe('your-settings');
    expect(ids(searchHelp('what does the usage page count', HELP_EN.articles, GLOSSARY_EN, 'usage', ['admin']))[0]).toBe('the-usage-page');
    expect(ids(searchHelp('what does the usage page count', HELP_EN.articles, GLOSSARY_EN, 'usage', ['reader']))).not.toContain('the-usage-page');
  });
});

describe('questions about a patient (spec 051 section 5, H-D6)', () => {
  const mustRefuse = [
    'what should I give SYN-0042?',
    'syn-ab12cd34 dose',
    'is *2/*2 bad',
    'CYP2C19*17 and clopidogrel',
    'what does activity score 1.5 mean for him',
    'can my patient take clopidogrel',
    'should she take simvastatin',
    'what dose for this patient',
    'este paciente puede tomar clopidogrel',
    '¿Qué dosis le doy a la paciente?',
    'Should I switch his medication?',
  ];
  const mustAnswer = [
    'what is a held result',
    'how do I add a patient',
    'what does phenotype mean',
    'how do I record a decision for a patient',
    'where are the follow-ups',
    'what is a star allele',
    'what is an activity score',
    'cómo añadir un paciente',
    'why can I not record a decision',
    'what does the patient page show',
  ];
  it('refuses every question on the must-refuse list', () => {
    for (const question of mustRefuse) expect(isPatientQuestion(question), question).toBe(true);
  });
  it('answers every question on the must-answer list', () => {
    for (const question of mustAnswer) expect(isPatientQuestion(question), question).toBe(false);
  });
});
