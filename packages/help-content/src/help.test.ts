import { describe, expect, it } from 'vitest';
import { HELP_EN, HELP_ES, HELP_SCREENS, helpFileSchema, untwinnedIds } from './index';

// Spec 051 slice H1. The articles are draft wording awaiting the founders' review (H-D1); these tests hold the rules every article keeps.
const article = (extra: Record<string, unknown> = {}) => ({
  id: 'syn-article',
  title: 'Synthetic title',
  body: ['Synthetic paragraph.'],
  screens: ['worklist'],
  roles: 'all',
  keywords: ['synthetic'],
  links: [],
  status: 'draft',
  signedBy: [],
  ...extra,
});
const signer = (name: string) => ({ name, role: 'Pharmacist', date: '2026-11-24' });
const file = (articles: unknown[], extra: Record<string, unknown> = {}) => ({ language: 'en', refusal: null, articles, ...extra });
const words = (item: (typeof HELP_EN.articles)[number]) => [item.title, ...item.body, ...item.links.map((link) => link.label)];

describe('the English help', () => {
  it('has the first articles of spec 051 section 3', () => {
    const ids = HELP_EN.articles.map((item) => item.id);
    for (const id of [
      'what-help-answers',
      'the-worklist',
      'held-results',
      'follow-ups',
      'find-or-add-a-patient',
      'attach-a-report',
      'the-genomic-profile',
      'phenoconversion-notice',
      'recording-a-decision',
      'roles',
      'synthetic-data-only',
      'words-used-here',
      'policies',
      'your-settings',
      'the-usage-page',
    ]) {
      expect(ids).toContain(id);
    }
  });

  it('never reassures: no article and not the refusal says safe, no interaction, not affected or none', () => {
    for (const item of HELP_EN.articles) for (const text of words(item)) expect(text, item.id).not.toMatch(/\bsafe\b|no interaction|not affected|\bnone\b/i);
    expect(HELP_EN.refusal!.body).not.toMatch(/\bsafe\b|no interaction|not affected|\bnone\b/i);
  });

  it('quotes no policy: the policies article says they are not published (H-D2)', () => {
    const policies = HELP_EN.articles.find((item) => item.id === 'policies')!;
    expect(policies.body.join(' ')).toContain('have not been published yet');
    expect(policies.links).toEqual([]);
  });

  it('is draft until two pharmacists sign: every article and the refusal sentence are drafts that name nobody', () => {
    for (const item of HELP_EN.articles) expect({ id: item.id, status: item.status, signedBy: item.signedBy }).toEqual({ id: item.id, status: 'draft', signedBy: [] });
    expect(HELP_EN.refusal).toEqual({ body: expect.any(String), status: 'draft', signedBy: [] });
  });

  it('links only to screens without a parameter, by their routes', () => {
    for (const item of HELP_EN.articles) for (const link of item.links) expect(HELP_SCREENS[link.screen], item.id).not.toContain(':');
  });
});

describe('the Spanish help', () => {
  it('waits for the founders: empty, with no refusal sentence yet (H-D1, spec 050)', () => {
    expect(HELP_ES).toEqual({ language: 'es', refusal: null, articles: [] });
  });

  it('may hold only versions of English articles: an id with no English twin is named', () => {
    const en = helpFileSchema.parse(file([article({ id: 'syn-one' })]));
    const es = helpFileSchema.parse(file([article({ id: 'syn-one' }), article({ id: 'syn-two' })], { language: 'es' }));
    expect(untwinnedIds(en, es)).toEqual(['syn-two']);
    // control
    expect(untwinnedIds(en, helpFileSchema.parse(file([article({ id: 'syn-one' })], { language: 'es' })))).toEqual([]);
    expect(untwinnedIds(HELP_EN, HELP_ES)).toEqual([]);
  });
});

describe('the rules', () => {
  it('refuses a signed article with fewer than two pharmacists, and a draft that names any', () => {
    expect(() => helpFileSchema.parse(file([article({ status: 'signed', signedBy: [signer('Synthetic A')] })]))).toThrow();
    expect(() => helpFileSchema.parse(file([article({ status: 'draft', signedBy: [signer('Synthetic A')] })]))).toThrow();
    // controls
    expect(() => helpFileSchema.parse(file([article({ status: 'signed', signedBy: [signer('Synthetic A'), signer('Synthetic B')] })]))).not.toThrow();
    expect(() => helpFileSchema.parse(file([article()]))).not.toThrow();
  });

  it('holds the refusal sentence to the same rule', () => {
    expect(() => helpFileSchema.parse(file([], { refusal: { body: 'Synthetic.', status: 'signed', signedBy: [signer('Synthetic A')] } }))).toThrow();
    // control
    expect(() => helpFileSchema.parse(file([], { refusal: { body: 'Synthetic.', status: 'draft', signedBy: [] } }))).not.toThrow();
  });

  it('is plain text: refuses markup, a Markdown link or a web address in a title, a paragraph or a link label', () => {
    for (const bad of ['<b>Synthetic</b>', '[here](/patients)', 'See https://example.org', 'See www.example.org']) {
      expect(() => helpFileSchema.parse(file([article({ body: [bad] })])), bad).toThrow();
      expect(() => helpFileSchema.parse(file([article({ title: bad })])), bad).toThrow();
      expect(() => helpFileSchema.parse(file([article({ links: [{ label: bad, screen: 'patients' }] })])), bad).toThrow();
    }
    expect(() => helpFileSchema.parse(file([article({ body: [''] })]))).toThrow();
    // control: ordinary punctuation is plain text
    expect(() => helpFileSchema.parse(file([article({ body: ["A held result's line says why: see Words used here."] })]))).not.toThrow();
  });

  it('refuses a screen it does not know, and a link to a screen with a parameter', () => {
    expect(() => helpFileSchema.parse(file([article({ screens: ['dashboard'] })]))).toThrow();
    expect(() => helpFileSchema.parse(file([article({ links: [{ label: 'Open the patient', screen: 'patient' }] })]))).toThrow();
    expect(() => helpFileSchema.parse(file([article({ links: [{ label: 'Open', screen: '/patients' }] })]))).toThrow();
    // controls
    expect(() => helpFileSchema.parse(file([article({ screens: ['patient'] })]))).not.toThrow();
    expect(() => helpFileSchema.parse(file([article({ links: [{ label: 'Open Patients', screen: 'patients' }] })]))).not.toThrow();
  });

  it('refuses a role it does not know, and an empty list of roles', () => {
    expect(() => helpFileSchema.parse(file([article({ roles: ['pharmacist'] })]))).toThrow();
    expect(() => helpFileSchema.parse(file([article({ roles: [] })]))).toThrow();
    // control
    expect(() => helpFileSchema.parse(file([article({ roles: ['reader', 'clinician'] })]))).not.toThrow();
  });

  it('refuses an id used twice, a field it does not know, and a language it does not know', () => {
    expect(() => helpFileSchema.parse(file([article(), article()]))).toThrow();
    expect(() => helpFileSchema.parse(file([article({ patient: 'syn-1' })]))).toThrow();
    expect(() => helpFileSchema.parse(file([], { language: 'fr' }))).toThrow();
    // control
    expect(() => helpFileSchema.parse(file([article(), article({ id: 'syn-other' })]))).not.toThrow();
  });
});
