import { describe, expect, it } from 'vitest';
import type { RouteObject } from 'react-router-dom';
import { routes } from '@/app/routes';
import { defineWords, type AnyWordTable, type WordShape, type WordValue } from './defineWords';
import { WORD_TABLES } from './index';
import { SCREENS, TRANSLATED_SCREENS, wordsIn } from './screens';

// Spec 050 LS1: every word table is checked here (R4, R7, R10), and each check is shown to fail on a broken table (the controls below).

const sentinel = (i: number) => `SENTINEL-${i}`;
/** A value as text: a function is called with sentinel placeholders. */
const render = (value: WordValue) => (typeof value === 'function' ? (value as (...args: string[]) => string)(...[0, 1, 2, 3].map(sentinel)) : value);
const placeholders = (value: WordValue) => (typeof value === 'function' ? value.length : 0);

function tableProblems(table: AnyWordTable): string[] {
  const problems: string[] = [];
  const languages: [string, WordShape][] = [['en', table.en]];
  if (table.es) languages.push(['es', table.es]);
  if (table.es) {
    const en = Object.keys(table.en).sort();
    const es = Object.keys(table.es).sort();
    if (en.join() !== es.join()) problems.push(`${table.id}: the Spanish keys differ from the English (${es.join()} vs ${en.join()})`);
  }
  for (const [key, value] of Object.entries(table.en)) {
    const spanish = table.es?.[key];
    if (render(value).trim() === '') problems.push(`${table.id}.${key}: the English is empty`);
    if (spanish === undefined) continue;
    if (render(spanish).trim() === '') problems.push(`${table.id}.${key}: the Spanish is empty`);
    if (render(spanish) === render(value)) problems.push(`${table.id}.${key}: the Spanish equals the English`);
    // R4: a placeholder appears in both languages.
    for (let i = 0; i < placeholders(value); i++) {
      if (!render(spanish).includes(sentinel(i))) problems.push(`${table.id}.${key}: the Spanish drops placeholder ${i + 1}`);
    }
  }
  // R7: a clinical table's Spanish names two pharmacist signers and a date.
  if (table.clinical && table.es) {
    const names = new Set(table.signedBy.map((signer) => signer.name.trim()).filter(Boolean));
    const dated = table.signedBy.every((signer) => /^\d{4}-\d{2}-\d{2}$/.test(signer.date) && signer.role.trim() !== '');
    if (names.size < 2 || !dated) problems.push(`${table.id}: clinical Spanish needs two named, dated signers`);
  }
  // R10: an accessible name starts with its visible word, in each language.
  for (const [visible, name] of table.namePairs) {
    for (const [language, words] of languages) {
      const shown = words[visible];
      const named = words[name];
      if (shown === undefined || named === undefined) problems.push(`${table.id}: name pair ${visible}/${name} is not in the table`);
      else if (!render(named).startsWith(render(shown))) problems.push(`${table.id}.${name} (${language}) does not start with ${visible}`);
    }
  }
  return problems;
}

describe('every word table (spec 050 R4, R7, R10)', () => {
  it('has at least one table to check: a scan of nothing proves nothing', () => {
    expect(WORD_TABLES.length).toBeGreaterThan(0);
  });

  it('passes every check', () => {
    expect(WORD_TABLES.flatMap(tableProblems)).toEqual([]);
  });

  it('gives each table a distinct id', () => {
    const ids = WORD_TABLES.map((table) => table.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('the checks fail on a broken table (controls)', () => {
  const good = defineWords({
    id: 'control',
    clinical: true,
    namePairs: [['retry', 'retryName']],
    signedBy: [
      { name: 'Pharmacist A', role: 'PharmD', date: '2026-11-25' },
      { name: 'Pharmacist B', role: 'PharmD', date: '2026-11-25' },
    ],
    en: { greet: (label: string) => `Patient ${label}`, retry: 'Retry', retryName: 'Retry the read' },
    es: { greet: (label: string) => `Paciente ${label}`, retry: 'Reintentar', retryName: 'Reintentar la lectura' },
  });

  it('a well-formed table passes', () => {
    expect(tableProblems(good)).toEqual([]);
  });

  it('a Spanish value that drops its placeholder fails', () => {
    expect(tableProblems({ ...good, es: { ...good.es!, greet: () => 'Paciente' } })).toEqual([expect.stringContaining('drops placeholder 1')]);
  });

  it('a Spanish value equal to its English fails', () => {
    expect(tableProblems({ ...good, es: { ...good.es!, retry: 'Retry', retryName: 'Retry la lectura' } })).toEqual([expect.stringContaining('equals the English')]);
  });

  it('clinical Spanish with one signer, or the same signer twice, fails (two distinct signers pass, above)', () => {
    expect(tableProblems({ ...good, signedBy: [good.signedBy[0]!] })).toEqual([expect.stringContaining('two named, dated signers')]);
    expect(tableProblems({ ...good, signedBy: [good.signedBy[0]!, { ...good.signedBy[0]! }] })).toEqual([expect.stringContaining('two named')]);
  });

  it('an accessible name that does not start with its visible word fails', () => {
    expect(tableProblems({ ...good, es: { ...good.es!, retryName: 'Volver a leer' } })).toEqual([expect.stringContaining('does not start with retry')]);
  });

  it('a Spanish table with a missing or an extra key does not compile, and is caught at run time too', () => {
    defineWords({
      id: 'missing',
      en: { one: 'One', two: 'Two' },
      // @ts-expect-error: the Spanish lacks `two`
      es: { one: 'Uno' },
    });
    defineWords({
      id: 'extra',
      en: { one: 'One' },
      // @ts-expect-error: the Spanish has a key the English has not
      es: { one: 'Uno', two: 'Dos' },
    });
    expect(tableProblems({ ...good, es: { greet: good.es!.greet, retry: 'Reintentar' } })).toContainEqual(expect.stringContaining('keys differ'));
  });

  it('a table with no Spanish gives its English in either language', () => {
    const englishOnly = defineWords({ id: 'english-only', en: { one: 'One' } });
    expect(wordsIn(englishOnly, 'es').one).toBe('One');
    expect(wordsIn(good, 'es').retry).toBe('Reintentar');
    expect(wordsIn(good, 'en').retry).toBe('Retry');
  });
});

describe('screens (spec 050 LS1-D2)', () => {
  it('no screen is translated yet: LS1 writes no Spanish', () => {
    expect([...TRANSLATED_SCREENS]).toEqual([]);
  });

  it('every route that names a screen names a known one, and the four screens are named', () => {
    const named: string[] = [];
    function walk(list: RouteObject[]) {
      for (const route of list) {
        const screen = (route.handle as { screen?: unknown } | undefined)?.screen;
        if (screen !== undefined) named.push(String(screen));
        if (route.children) walk(route.children);
      }
    }
    walk(routes);
    expect(named.filter((screen) => !(SCREENS as readonly string[]).includes(screen))).toEqual([]);
    expect(new Set(named)).toEqual(new Set(['home', 'patient', 'sign-in']));
  });
});
