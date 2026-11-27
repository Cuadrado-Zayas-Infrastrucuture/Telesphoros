import { describe, expect, it } from 'vitest';
import { GLOSSARY_EN, glossaryEntryFor, glossaryFileSchema } from './index';

// Spec 044 slice B part 2. The entries are draft wording awaiting the founders' review (B2-D2); these tests hold the rules every entry keeps.
const entry = (extra: Record<string, unknown> = {}) => ({
  id: 'syn-term',
  term: 'Synthetic term',
  aliases: ['Synthetic term'],
  body: 'Synthetic body.',
  status: 'draft',
  signedBy: [],
  ...extra,
});
const signer = (name: string) => ({ name, role: 'Pharmacist', date: '2026-11-23' });
const file = (...entries: unknown[]) => ({ language: 'en', entries });

describe('the glossary file', () => {
  it('has the first terms of plan-slice-b.md section 6 and spec 045 N3-D1', () => {
    const ids = GLOSSARY_EN.map((item) => item.id);
    for (const id of [
      'phenotype',
      'diplotype',
      'star-allele',
      'activity-score',
      'normal-metabolizer',
      'intermediate-metabolizer',
      'poor-metabolizer',
      'rapid-metabolizer',
      'ultrarapid-metabolizer',
      'decreased-function',
      'increased-function',
      'poor-function',
      'guidance-to-review',
      'held',
      'no-guideline-loaded',
      'no-recommendation',
      'not-tested',
      'phenoconversion',
      'cpic',
    ]) {
      expect(ids).toContain(id);
    }
  });

  it('never reassures: no entry says safe, no interaction, not affected or none', () => {
    for (const item of GLOSSARY_EN) expect(item.body).not.toMatch(/\bsafe\b|no interaction|not affected|\bnone\b/i);
  });

  it('is plain text: no markup and no links', () => {
    for (const item of GLOSSARY_EN) expect(item.body).not.toMatch(/<|>|\]\(|https?:/);
  });

  it('is draft until two pharmacists sign: every entry today is a draft that names nobody', () => {
    for (const item of GLOSSARY_EN) expect({ id: item.id, status: item.status, signedBy: item.signedBy }).toEqual({ id: item.id, status: 'draft', signedBy: [] });
  });
});

describe('the rules', () => {
  it('refuses a signed entry with fewer than two pharmacists, and a draft that names any', () => {
    expect(() => glossaryFileSchema.parse(file(entry({ status: 'signed', signedBy: [signer('Synthetic A')] })))).toThrow();
    expect(() => glossaryFileSchema.parse(file(entry({ status: 'draft', signedBy: [signer('Synthetic A')] })))).toThrow();
    // controls
    expect(() => glossaryFileSchema.parse(file(entry({ status: 'signed', signedBy: [signer('Synthetic A'), signer('Synthetic B')] })))).not.toThrow();
    expect(() => glossaryFileSchema.parse(file(entry()))).not.toThrow();
  });

  it('refuses a signature without a real date', () => {
    expect(() => glossaryFileSchema.parse(file(entry({ status: 'signed', signedBy: [signer('Synthetic A'), { ...signer('Synthetic B'), date: 'soon' }] })))).toThrow();
  });

  it('refuses an id used twice, and an alias that belongs to two entries, ignoring letter case', () => {
    expect(() => glossaryFileSchema.parse(file(entry(), entry({ aliases: ['Other'] })))).toThrow();
    expect(() => glossaryFileSchema.parse(file(entry(), entry({ id: 'syn-other', aliases: ['SYNTHETIC  term'] })))).toThrow();
    // control
    expect(() => glossaryFileSchema.parse(file(entry(), entry({ id: 'syn-other', aliases: ['Other'] })))).not.toThrow();
  });

  it('refuses a field it does not know', () => {
    expect(() => glossaryFileSchema.parse(file(entry({ patient: 'syn-1' })))).toThrow();
  });
});

describe('finding an entry for a screen string', () => {
  it('matches a whole alias, ignoring letter case and repeated spaces', () => {
    expect(glossaryEntryFor('Poor Metabolizer')?.id).toBe('poor-metabolizer');
    expect(glossaryEntryFor('  poor   metabolizer ')?.id).toBe('poor-metabolizer');
  });

  it('never guesses: part of a term, or a term inside a longer string, has no entry', () => {
    expect(glossaryEntryFor('Poor')).toBeNull();
    expect(glossaryEntryFor('Likely Poor Metabolizer')).toBeNull();
    expect(glossaryEntryFor('Synthetic Poor')).toBeNull();
  });
});
