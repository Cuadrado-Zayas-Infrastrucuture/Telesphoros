import { describe, expect, it } from 'vitest';
import { GLOSSARY_EN, HELP_EN, HELP_ROLES } from '@telesphoros/help-content';
import { ROLES } from '@telesphoros/shared-types';
import { articlesForContext, helpScreenForPath, visibleArticlesForRoles } from './helpContext';
import { searchHelp } from './helpSearch';

describe('helpContext (spec 051 section 2)', () => {
  it('keeps HELP_ROLES aligned with shared-types ROLES', () => {
    expect([...HELP_ROLES].sort()).toEqual([...ROLES].sort());
  });

  it('maps app routes to HelpScreen ids', () => {
    expect(helpScreenForPath('/workspace')).toBe('worklist');
    expect(helpScreenForPath('/chat')).toBe('chat');
    expect(helpScreenForPath('/patients')).toBe('patients');
    expect(helpScreenForPath('/patients/new')).toBe('new-patient');
    expect(helpScreenForPath('/patients/patient-123')).toBe('patient');
    expect(helpScreenForPath('/reports')).toBe('reports');
    expect(helpScreenForPath('/reports/upload')).toBe('reports');
    expect(helpScreenForPath('/follow-ups')).toBe('follow-ups');
    expect(helpScreenForPath('/settings')).toBe('settings');
    expect(helpScreenForPath('/usage')).toBe('usage');
    expect(helpScreenForPath('/unknown-route')).toBeNull();
  });

  it('shows worklist articles for clinician and excludes clinical how-tos for admin', () => {
    const clinicianWorklist = articlesForContext(HELP_EN.articles, 'worklist', ['clinician']).map((a) => a.id);
    expect(clinicianWorklist).toContain('the-worklist');
    expect(clinicianWorklist).toContain('held-results');
    expect(clinicianWorklist).toContain('attach-a-report');

    const readerVisible = visibleArticlesForRoles(HELP_EN.articles, ['reader']).map((a) => a.id);
    expect(readerVisible).toContain('held-results');
    expect(readerVisible).not.toContain('attach-a-report');
    expect(readerVisible).not.toContain('follow-ups');

    const adminVisible = visibleArticlesForRoles(HELP_EN.articles, ['admin']).map((a) => a.id);
    expect(adminVisible).toContain('roles');
    expect(adminVisible).toContain('policies');
    expect(adminVisible).not.toContain('the-worklist');
    expect(adminVisible).not.toContain('held-results');
    expect(adminVisible).not.toContain('attach-a-report');
  });
});

describe('searchHelp (spec 051 section 4)', () => {
  const clinicianArticles = visibleArticlesForRoles(HELP_EN.articles, ['clinician']);

  it('ranks title and keyword matches above body-only matches', () => {
    const result = searchHelp('held result', clinicianArticles, GLOSSARY_EN, 'worklist');
    expect(result.weak).toBe(false);
    expect(result.results[0]?.kind).toBe('article');
    if (result.results[0]?.kind === 'article') {
      expect(result.results[0].article.id).toBe('held-results');
    }
  });

  it('ignores accents, letter case, repeated spaces and filler words', () => {
    const plain = searchHelp('how do I attach a report', clinicianArticles, GLOSSARY_EN, 'worklist');
    const noisy = searchHelp('  CÓMO   ATTACH    A   RÉPORT  ', clinicianArticles, GLOSSARY_EN, 'worklist');
    expect(plain.weak).toBe(false);
    expect(noisy.weak).toBe(false);
    expect(noisy.results.map((r) => r.id)).toEqual(plain.results.map((r) => r.id));
    expect(plain.results[0]?.id).toBe('attach-a-report');
  });

  it('breaks ties by current screen first, then alphabetically', () => {
    const syntheticArticles = [
      { ...HELP_EN.articles[0]!, id: 'zeta-other', title: 'Zeta guide', body: ['Alpha token.'], keywords: ['sharedword'], screens: ['usage' as const] },
      { ...HELP_EN.articles[0]!, id: 'alpha-other', title: 'Alpha guide', body: ['Alpha token.'], keywords: ['sharedword'], screens: ['usage' as const] },
      { ...HELP_EN.articles[0]!, id: 'omega-here', title: 'Omega guide', body: ['Alpha token.'], keywords: ['sharedword'], screens: ['worklist' as const] },
    ];
    const result = searchHelp('sharedword', syntheticArticles, [], 'worklist');
    expect(result.weak).toBe(false);
    expect(result.results.map((r) => r.id)).toEqual(['omega-here', 'alpha-other', 'zeta-other']);
  });

  it('includes glossary entries marked as glossary words', () => {
    const result = searchHelp('what does phenotype mean', clinicianArticles, GLOSSARY_EN, 'patient');
    expect(result.weak).toBe(false);
    const glossaryHits = result.results.filter((r) => r.kind === 'glossary');
    expect(glossaryHits.length).toBeGreaterThan(0);
    expect(glossaryHits.some((r) => r.entry.term.toLowerCase() === 'phenotype')).toBe(true);
  });

  it('marks a weak match when best result matches fewer than half the query words and returns at most 3 closest', () => {
    const result = searchHelp('held quantum spaceship banana toaster', clinicianArticles, GLOSSARY_EN, 'worklist');
    expect(result.weak).toBe(true);
    expect(result.results.length).toBeLessThanOrEqual(3);
    expect(result.results.length).toBeGreaterThan(0);
  });
});
