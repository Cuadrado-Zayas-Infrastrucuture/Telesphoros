import { runInNewContext } from 'node:vm';
import { canonicalHash, canonicalJson, CanonicalJsonError, sha256Hex } from './canonical-json';

describe('canonical JSON (the reader\'s own serialization)', () => {
  it('sorts keys by UTF-16 code units and writes no whitespace', () => {
    expect(canonicalJson({ b: 1, a: [true, null, 'x'], '€': 2, B: 3 })).toBe('{"B":3,"a":[true,null,"x"],"b":1,"€":2}');
  });

  it('writes strings like the reader does: control characters escaped, everything else literal', () => {
    expect(canonicalJson('a"b\\c\n\t\u0001é💡')).toBe('"a\\"b\\\\c\\n\\t\\u0001é💡"');
  });

  it('refuses what the reader refuses: floats, unsafe integers, undefined, functions, lone surrogates, odd objects', () => {
    for (const value of [1.5, Number.NaN, Infinity, 2 ** 53, undefined, () => 1, 'ud800'.replace('ud800', String.fromCharCode(0xd800)), new Date(), new Map(), Symbol('x')]) {
      expect(() => canonicalJson(value)).toThrow(CanonicalJsonError);
    }
  });

  it('refuses without echoing the value', () => {
    try {
      canonicalJson(1.5);
    } catch (error) {
      expect((error as Error).message).not.toContain('1.5');
    }
  });

  it('accepts a plain object made in another realm, and still refuses class instances', () => {
    const foreign = runInNewContext('({ b: [1, { c: null }], a: "x" })') as unknown;
    expect(canonicalJson(foreign)).toBe('{"a":"x","b":[1,{"c":null}]}');
    expect(canonicalJson(Object.create(null))).toBe('{}');
    class Box { value = 1; }
    expect(() => canonicalJson(new Box())).toThrow(CanonicalJsonError);
  });

  it('hashes the canonical text', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(canonicalHash({ a: 1 })).toBe(sha256Hex('{"a":1}'));
  });
});
