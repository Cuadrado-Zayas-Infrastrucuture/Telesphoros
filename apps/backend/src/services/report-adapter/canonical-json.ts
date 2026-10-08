import { createHash } from 'node:crypto';

/** Thrown for a value outside the small domain the reader's canonical JSON covers. The message never includes the value. */
export class CanonicalJsonError extends Error {
  constructor(reason: string) {
    super(`Not canonicalizable: ${reason}`);
    this.name = 'CanonicalJsonError';
  }
}

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * RFC 8785 style canonical JSON, restricted to the types the reader's packets use (null, booleans, safe integers,
 * well-formed strings, arrays, plain objects). It must produce exactly the bytes the reader's own `jcs` does, so that a
 * packet's hash can be recomputed here; a test compares them on the real reader's output. Floats are refused, not rounded.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isInteger(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) throw new CanonicalJsonError('number');
      return String(value);
    case 'string':
      if (LONE_SURROGATE.test(value)) throw new CanonicalJsonError('string');
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
      // A plain object has no prototype, or one whose own prototype is null. (Comparing with Object.prototype would refuse
      // plain objects made in another realm, which are just as plain.)
      const proto = Object.getPrototypeOf(value) as object | null;
      if (proto !== null && Object.getPrototypeOf(proto) !== null) throw new CanonicalJsonError('object');
      const record = value as Record<string, unknown>;
      // Keys sort by UTF-16 code units, which is what JavaScript's default string order is.
      const keys = Object.keys(record).sort();
      return `{${keys.map((key) => `${canonicalJson(key)}:${canonicalJson(record[key])}`).join(',')}}`;
    }
    default:
      throw new CanonicalJsonError('type');
  }
}

export const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** The reader's `h(v)`: SHA-256 of the canonical JSON. */
export const canonicalHash = (value: unknown): string => sha256Hex(canonicalJson(value));
