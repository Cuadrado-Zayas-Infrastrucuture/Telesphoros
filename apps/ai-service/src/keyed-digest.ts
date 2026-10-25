import { createHmac } from 'node:crypto';

export const KEY_MIN_BYTES = 32;
export const KEYED_DIGEST = /^hmac-sha256:[0-9a-f]{64}$/;

/** JSON with object keys sorted, so equal values give equal text. Throws on a cycle or a value JSON cannot hold. */
export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 64) throw new Error('CANONICAL_TOO_DEEP');
  if (value === undefined || value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('CANONICAL_NUMBER');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v, depth + 1)).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k], depth + 1)}`)
      .join(',')}}`;
  }
  throw new Error('CANONICAL_TYPE');
}

/**
 * HMAC-SHA-256 of the data under a secret key (FR-009). The evidence is a small space (a gene, a phenotype, a drug), so a plain SHA-256 of it could be
 * reversed by trying every candidate; a keyed digest cannot without the key. The prefix differs from `sha256:` so the two are never mistaken for each other.
 * The key comes from the caller (the secrets store, wired at the composition root); this file reads no environment and keeps no key.
 */
export function keyedDigest(key: Uint8Array, data: string): string {
  if (!(key instanceof Uint8Array) || key.length < KEY_MIN_BYTES) throw new Error('KEY_TOO_SHORT');
  return `hmac-sha256:${createHmac('sha256', key).update(data, 'utf8').digest('hex')}`;
}
