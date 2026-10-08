import type { AdapterKnowledge } from './adapter-knowledge';
import { adaptOccurrence, duplicateInput, type FieldState, MAX_VALUE_LENGTH, type OccurrenceFacts, resultBasis } from './adapt-occurrence';

// A tiny knowledge stand-in, written independently of the real mapper: two canonical terms and three diplotypes.
const CANON = ['Normal Metabolizer', 'Intermediate Metabolizer', 'Poor Metabolizer'];
const MAPS: Record<string, string> = { '*1/*1': 'Normal Metabolizer', '*1/*2': 'Intermediate Metabolizer', '*2/*2': 'Poor Metabolizer' };
const knowledge: AdapterKnowledge = {
  canonicalPhenotypes: (gene) => (gene === 'GENEX' ? null : CANON),
  mapDiplotype: (gene, diplotype) => (gene !== 'GENEX' && MAPS[diplotype] ? { mapped: true, phenotype: MAPS[diplotype]! } : { mapped: false }),
};

const present = (text: string): FieldState => ({ state: 'present', text });
const MISSING: FieldState = { state: 'missing' };
const EMPTY: FieldState = { state: 'empty' };
const facts = (diplotype: FieldState, result: FieldState, gene = 'CYP2C19'): OccurrenceFacts => ({ gene, diplotype, result });
const G = 'CYP2C19';
const other = { gene: G, state: 'unresolved', reasonCode: 'other-gene-unresolved' };
const dipInput = (d: string) => ({ gene: G, state: 'diplotype', diplotype: d });
const canon = (p: string) => ({ gene: G, state: 'canonical', phenotype: p });
const nullInput = { gene: G, state: 'null' };

describe('one occurrence to engine input (spec section 5.2, as amended)', () => {
  it.each([
    // diplotype present and mappable
    ['a diplotype and no result field is unresolved (R04)', facts(present('*1/*2'), MISSING), [other], 'no-reported-result'],
    ['a diplotype and an empty result is unresolved', facts(present('*1/*2'), EMPTY), [other], 'empty-field'],
    ['a diplotype and the result it maps to', facts(present('*1/*2'), present('Intermediate Metabolizer')), [dipInput('*1/*2')], 'corroborated'],
    ['a diplotype and a different canonical result', facts(present('*1/*2'), present('Poor Metabolizer')), [dipInput('*1/*2'), canon('Poor Metabolizer')], 'conflict'],
    ['a diplotype and an unavailable result', facts(present('*1/*2'), present('not available')), [other], 'result-untrusted'],
    ['a diplotype and a quoted result', facts(present('*1/*2'), present('"Intermediate Metabolizer"')), [other], 'result-untrusted'],
    ['a diplotype and an unfamiliar result', facts(present('*1/*2'), present('Indeterminate')), [other], 'result-untrusted'],
    // diplotype present, not mappable: goes to the engine for its precise reason, whatever the result says
    ['an unmappable diplotype and no result', facts(present('*1/*Z'), MISSING), [dipInput('*1/*Z')], null],
    ['an unmappable diplotype and a canonical result', facts(present('*1/*Z'), present('Normal Metabolizer')), [dipInput('*1/*Z')], null],
    ['an unmappable diplotype and an empty result', facts(present('*1/*Z'), EMPTY), [dipInput('*1/*Z')], null],
    // empty diplotype
    ['an empty diplotype beside a result', facts(EMPTY, present('Normal Metabolizer')), [other], 'empty-field'],
    ['an empty diplotype and no result', facts(EMPTY, MISSING), [nullInput], 'empty-field'],
    ['an empty diplotype and an empty result', facts(EMPTY, EMPTY), [nullInput], 'empty-field'],
    // no diplotype
    ['a canonical result alone', facts(MISSING, present('Normal Metabolizer')), [canon('Normal Metabolizer')], null],
    ['an unavailable result alone', facts(MISSING, present('Not Available.')), [nullInput], 'unavailable'],
    ['a quoted unavailable result alone (D03)', facts(MISSING, present('"not available"')), [other], 'result-untrusted'],
    ['the literal "no result" alone', facts(MISSING, present('no result')), [other], 'result-untrusted'],
    ['an unfamiliar result alone', facts(MISSING, present('Indeterminate')), [other], 'result-untrusted'],
    ['an empty result alone (D05)', facts(MISSING, EMPTY), [nullInput], 'empty-field'],
    ['a gene named and nothing said', facts(MISSING, MISSING), [other], 'nothing-stated'],
  ])('%s', (_name, input, emitted, note) => {
    expect(adaptOccurrence(input, knowledge)).toEqual({ emitted, note });
  });

  it('when the knowledge has no definition for the gene, a diplotype or a value goes to the engine, which says so', () => {
    const gene = 'GENEX';
    expect(adaptOccurrence(facts(present('*1/*2'), present('Normal Metabolizer'), gene), knowledge).emitted).toEqual([{ gene, state: 'diplotype', diplotype: '*1/*2' }]);
    expect(adaptOccurrence(facts(MISSING, present('Normal Metabolizer'), gene), knowledge).emitted).toEqual([{ gene, state: 'canonical', phenotype: 'Normal Metabolizer' }]);
    expect(adaptOccurrence(facts(MISSING, present('not reported'), gene), knowledge)).toEqual({ emitted: [{ gene, state: 'null' }], note: 'unavailable' });
  });

  it('never emits a value the engine\'s schema would refuse: over-long text is unresolved', () => {
    const long = 'x'.repeat(MAX_VALUE_LENGTH + 1);
    expect(adaptOccurrence(facts(present(long), MISSING), knowledge).emitted).toEqual([other]);
    expect(adaptOccurrence(facts(MISSING, present(long)), knowledge).emitted).toEqual([other]);
    expect(adaptOccurrence(facts(MISSING, present(long), 'GENEX'), knowledge).emitted).toEqual([{ gene: 'GENEX', state: 'unresolved', reasonCode: 'other-gene-unresolved' }]);
  });

  it('does not change what it is given', () => {
    const input = facts(present('*1/*2'), present('Intermediate Metabolizer'));
    const before = JSON.stringify(input);
    adaptOccurrence(input, knowledge);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe('repeated genes (rule R03, option A)', () => {
  const same = facts(present('*1/*2'), present('Intermediate Metabolizer'));

  it('identical repeats are identical, byte for byte', () => {
    expect(duplicateInput(G, [same, { ...same }])).toEqual({ input: { gene: G, state: 'unresolved', reasonCode: 'duplicate-identical' }, note: 'duplicate-identical' });
    expect(duplicateInput(G, [same, same, same]).note).toBe('duplicate-identical');
  });

  it.each([
    ['a different diplotype', facts(present('*2/*2'), present('Intermediate Metabolizer'))],
    ['a different result', facts(present('*1/*2'), present('Poor Metabolizer'))],
    ['a result that differs only in case', facts(present('*1/*2'), present('intermediate metabolizer'))],
    ['a result that differs only by a trailing space', facts(present('*1/*2'), present('Intermediate Metabolizer '))],
    ['a result field missing', facts(present('*1/*2'), MISSING)],
    ['a result field empty', facts(present('*1/*2'), EMPTY)],
    ['a diplotype field missing', facts(MISSING, present('Intermediate Metabolizer'))],
    ['a diplotype field empty', facts(EMPTY, present('Intermediate Metabolizer'))],
  ])('differ by %s, so they conflict', (_name, other2) => {
    expect(duplicateInput(G, [same, other2]).note).toBe('duplicate-gene-conflict');
    expect(duplicateInput(G, [other2, same]).input).toEqual({ gene: G, state: 'unresolved', reasonCode: 'duplicate-gene-conflict' });
  });

  it('keeps a missing field apart from an empty one, for the diplotype as well as the result', () => {
    const result = present('Intermediate Metabolizer');
    expect(duplicateInput(G, [facts(MISSING, result), facts(EMPTY, result)]).note).toBe('duplicate-gene-conflict');
    expect(duplicateInput(G, [facts(EMPTY, result), facts(EMPTY, result)]).note).toBe('duplicate-identical');
  });

  it('keeps missing and empty apart, and differently worded unavailable tokens apart', () => {
    expect(duplicateInput(G, [facts(MISSING, MISSING), facts(MISSING, EMPTY)]).note).toBe('duplicate-gene-conflict');
    expect(duplicateInput(G, [facts(MISSING, present('not available')), facts(MISSING, present('Not Available'))]).note).toBe('duplicate-gene-conflict');
    expect(duplicateInput(G, [facts(MISSING, present('not available')), facts(MISSING, present('not available'))]).note).toBe('duplicate-identical');
  });

  it('never decides by normalizing: a conflict among three is a conflict whatever the order', () => {
    const a = facts(MISSING, present('Normal Metabolizer'));
    const b = facts(MISSING, present('Poor Metabolizer'));
    for (const order of [[a, a, b], [a, b, a], [b, a, a]]) expect(duplicateInput(G, order).note).toBe('duplicate-gene-conflict');
  });

  it('derives the result basis the specification names', () => {
    expect(resultBasis(facts(MISSING, present('x')))).toBe('reported-value');
    expect(resultBasis(facts(present('*1/*2'), EMPTY))).toBe('empty-field');
    expect(resultBasis(facts(present('*1/*2'), MISSING))).toBe('no-reported-result');
    expect(resultBasis(facts(MISSING, MISSING))).toBe('nothing-stated');
    expect(resultBasis(facts(EMPTY, MISSING))).toBe('nothing-stated');
  });
});
