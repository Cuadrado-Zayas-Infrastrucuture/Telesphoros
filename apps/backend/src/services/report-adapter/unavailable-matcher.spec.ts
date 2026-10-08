import { execFileSync } from 'node:child_process';
import { ASCII_ONLY_FULL_FOLDS, comparisonCopy, isUnavailableValue, UNAVAILABLE_TOKENS } from './unavailable-matcher';

const chr = (code: number) => String.fromCharCode(code);

describe('the R06 unavailable-value matcher', () => {
  it('knows exactly the seven approved tokens', () => {
    expect([...UNAVAILABLE_TOKENS]).toEqual(['not available', 'not reported', 'pending', 'no disponible', 'resultado no disponible', 'no reportado', 'pendiente']);
  });

  it('runs only on the Unicode version it is pinned to', () => {
    expect(process.versions.unicode).toBe('16.0');
  });

  it.each([
    ['not available', true],
    ['NOT AVAILABLE.', true],
    ['Not Reported', true],
    ['PENDING', true],
    ['no disponible', true],
    ['Resultado No Disponible.', true],
    ['no reportado', true],
    ['Pendiente', true],
    ['  not   available  ', true],
    ['not available .', false], // a space remains once the period is removed
    ['not available..', false], // one period remains
    ['"not available"', false], // quotation marks are part of the value
    ["'pending'", false],
    ['no result', false],
    ['sin resultado', false],
    ['Indeterminate', false],
    ['not available: lab', false],
    ['unavailable', false],
    ['', false],
    ['.', false],
    ['pend', false],
    ['pending result', false],
  ])('%j matches: %s', (value, expected) => {
    expect(isUnavailableValue(value)).toBe(expected);
  });

  it('collapses every Unicode White_Space code point between words, and nothing else', () => {
    const whiteSpace = [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, ...Array.from({ length: 11 }, (_, i) => 0x2000 + i), 0x2028, 0x2029, 0x202f, 0x205f, 0x3000];
    for (const code of whiteSpace) expect(isUnavailableValue(`not${chr(code)}available`)).toBe(true);
    // Zero-width space and the C0 separators are NOT White_Space, so they do not join the words.
    for (const code of [0x200b, 0x1c, 0x1d, 0x1e, 0x1f, 0xfeff]) expect(isUnavailableValue(`not${chr(code)}available`)).toBe(false);
  });

  it('trims only U+0020 after collapsing, and removes one period without trimming again', () => {
    expect(comparisonCopy(`${chr(0xa0)}${chr(0x2003)}pending${chr(0x3000)}`)).toBe('pending');
    expect(comparisonCopy('pending.')).toBe('pending');
    expect(comparisonCopy('pending .')).toBe('pending ');
    expect(comparisonCopy('pending..')).toBe('pending.');
  });

  it('applies NFC first, so a compatibility-free canonical equivalent matches', () => {
    // The Kelvin sign normalizes to K, then folds to k. No token contains k, but the sequence is observable.
    expect(comparisonCopy(`${chr(0x212a)}`)).toBe('k');
    expect(isUnavailableValue(`no di${chr(0x17f)}ponible`)).toBe(true); // long s folds to s
  });

  it('never changes what it is given, and never matches a different token spelling', () => {
    const value = 'Not Available.';
    isUnavailableValue(value);
    expect(value).toBe('Not Available.');
    expect(isUnavailableValue('not  available')).toBe(true); // spacing runs collapse
    expect(isUnavailableValue('notavailable')).toBe(false); // but never invented
  });

  it('uses the same restricted fold table an independent implementation derives across every code point', () => {
    // Python's str.casefold() is a second implementation of full case folding. The characters whose full fold is
    // ASCII-only (and which are not ASCII themselves) must be exactly the ones this module lists.
    const script = [
      'import json',
      'out = {}',
      'for cp in range(0x110000):',
      '    c = chr(cp)',
      '    f = c.casefold()',
      '    if f != c and f.isascii() and not c.isascii():',
      '        out[c] = f',
      'print(json.dumps(out))',
    ].join('\n');
    const derived = JSON.parse(execFileSync('python3', ['-I', '-c', script], { encoding: 'utf8' })) as Record<string, string>;
    expect(derived).toEqual(ASCII_ONLY_FULL_FOLDS);
  });
});
