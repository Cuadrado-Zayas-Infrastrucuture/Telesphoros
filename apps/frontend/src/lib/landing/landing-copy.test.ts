import { describe, expect, it } from 'vitest';
import { LANDING_COPY } from './landing-copy';

type Leaf = string | ((...args: never[]) => string);
/** Every path to a string or function in the copy, e.g. "questions.items.2.a". Arrays count by index. */
function paths(value: unknown, prefix = ''): Array<[string, Leaf]> {
  if (typeof value === 'string' || typeof value === 'function') return [[prefix, value as Leaf]];
  if (Array.isArray(value)) return value.flatMap((item, index) => paths(item, prefix ? `${prefix}.${index}` : String(index)));
  return Object.entries(value as object).flatMap(([key, item]) => paths(item, prefix ? `${prefix}.${key}` : key));
}

describe('landing copy', () => {
  const english = paths(LANDING_COPY.en);
  const spanish = paths(LANDING_COPY.es);

  it('has exactly the same entries in English and Spanish, in the same shape', () => {
    expect(spanish.map(([path]) => path)).toEqual(english.map(([path]) => path));
  });

  it('has no empty text in either language', () => {
    for (const [path, leaf] of [...english, ...spanish]) if (typeof leaf === 'string') expect([path, leaf.trim().length > 0]).toEqual([path, true]);
  });

  it('keeps the same function entries callable with the same arguments', () => {
    expect(LANDING_COPY.en.workflow.kicker(2)).toBe('Explore step 02 / 03');
    expect(LANDING_COPY.es.workflow.kicker(2)).toContain('02 / 03');
    expect(LANDING_COPY.en.workflow.next('Check')).toBe('Next: check');
    expect(LANDING_COPY.es.workflow.next('Verificar')).toBe('Siguiente: verificar');
  });

  it('keeps every boundary statement in both languages: synthetic only, not clinical, no medication or dose advice', () => {
    const text = (language: 'en' | 'es') =>
      paths(LANDING_COPY[language])
        .map(([, leaf]) => (typeof leaf === 'string' ? leaf : ''))
        .join('\n')
        .toLowerCase();
    for (const phrase of [
      'synthetic data only',
      'not for clinical use',
      'does not recommend medications or doses',
      'does not indicate clinical review',
      'confirms storage, not clinical review',
    ])
      expect(text('en')).toContain(phrase);
    for (const phrase of [
      'solo datos sintéticos',
      'no apto para uso clínico',
      'no recomienda medicamentos ni dosis',
      'no indica revisión clínica',
      'confirma el almacenamiento, no una revisión clínica',
    ])
      expect(text('es')).toContain(phrase);
  });

  it('English is the text the landing has always carried', () => {
    expect(LANDING_COPY.en.hero.headline.join(' ')).toBe('A clearer view of your PGx reports.');
    expect(LANDING_COPY.en.header.skip).toBe('Skip to main content');
    expect(LANDING_COPY.en.closing.mascotAlt).toBe('Telesphoros mascot in a teal cloak');
  });
});
