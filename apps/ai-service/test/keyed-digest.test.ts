import { describe, expect, test } from 'vitest';
import { RESULTS } from '../evals/golden/results';
import { hashBytes } from '../src/evidence';
import { canonicalJson, KEY_MIN_BYTES, KEYED_DIGEST, keyedDigest } from '../src/keyed-digest';

const key = new Uint8Array(32).fill(1);
const evidence = canonicalJson(RESULTS.avoid);

describe('keyed digests (FR-009)', () => {
  test('are deterministic, keyed, and shaped differently from a plain digest', () => {
    const d = keyedDigest(key, evidence);
    expect(d).toMatch(KEYED_DIGEST);
    expect(keyedDigest(key, evidence)).toBe(d);
    expect(keyedDigest(new Uint8Array(32).fill(2), evidence)).not.toBe(d);
    expect(keyedDigest(key, evidence + ' ')).not.toBe(d);
    expect(d).not.toMatch(/^sha256:/);
  });
  test('an attacker who can enumerate every candidate evidence value still cannot match the stored digest with a plain hash', () => {
    const stored = keyedDigest(key, evidence);
    const candidates = Object.values(RESULTS).map((r) => canonicalJson(r));
    expect(candidates).toContain(evidence);
    expect(candidates.map((c) => hashBytes(c))).not.toContain(stored);
    expect(candidates.map((c) => hashBytes(c).replace('sha256:', 'hmac-sha256:'))).not.toContain(stored);
  });
  test('control: with the key the same enumeration does find it', () =>
    expect(Object.values(RESULTS).map((r) => keyedDigest(key, canonicalJson(r)))).toContain(keyedDigest(key, evidence)));
  test('a key shorter than 32 bytes, or not bytes, is refused', () => {
    expect(KEY_MIN_BYTES).toBe(32);
    expect(() => keyedDigest(new Uint8Array(31), 'x')).toThrow('KEY_TOO_SHORT');
    expect(() => keyedDigest('a'.repeat(40) as unknown as Uint8Array, 'x')).toThrow('KEY_TOO_SHORT');
    expect(() => keyedDigest(new Uint8Array(32), 'x')).not.toThrow();
  });
});
describe('canonicalJson', () => {
  test('is independent of key order and exact for nested values', () => {
    expect(canonicalJson({ b: [1, { d: 4, c: 3 }], a: null })).toBe('{"a":null,"b":[1,{"c":3,"d":4}]}');
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });
  test('refuses what JSON cannot hold or a cycle', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const bad of [cyclic, 1n, () => 1, Symbol('x'), Number.NaN, Infinity]) expect(() => canonicalJson(bad)).toThrow();
  });
});
