import { TextDecoder } from 'node:util';
import { canonicalHash, canonicalJson, sha256Hex } from '../report-adapter/canonical-json';

export const MAX_INPUT_BYTES = 1024 * 1024;
export const MAX_SOURCE_SCALARS = 100000;

/** Restricted record JSON. Duplicate keys (including escaped aliases) are rejected before object construction. */
export function parseRecordJson(raw: string): unknown {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_INPUT_BYTES) throw new Error('lookup-input-invalid');
  let at = 0;
  const fail = (): never => {
    throw new Error('lookup-input-invalid');
  };
  const space = () => {
    while (/[ \t\r\n]/.test(raw[at] ?? 'x')) at += 1;
  };
  const string = (): string => {
    const start = at++;
    while (at < raw.length) {
      const char = raw[at++];
      if (char === '\\') at += 1;
      else if (char === '"') {
        const value: unknown = JSON.parse(raw.slice(start, at));
        canonicalJson(value);
        return value as string;
      }
    }
    return fail();
  };
  const value = (depth: number): unknown => {
    if (depth > 64) return fail();
    space();
    if (raw[at] === '"') return string();
    if (raw[at] === '{') {
      at += 1;
      space();
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      const seen = new Set<string>();
      if (raw[at] === '}') {
        at += 1;
        return result;
      }
      while (true) {
        space();
        if (raw[at] !== '"') return fail();
        const key = string();
        if (seen.has(key)) return fail();
        seen.add(key);
        space();
        if (raw[at++] !== ':') return fail();
        result[key] = value(depth + 1);
        space();
        const next = raw[at++];
        if (next === '}') return result;
        if (next !== ',') return fail();
      }
    }
    if (raw[at] === '[') {
      at += 1;
      space();
      const result: unknown[] = [];
      if (raw[at] === ']') {
        at += 1;
        return result;
      }
      while (true) {
        result.push(value(depth + 1));
        space();
        const next = raw[at++];
        if (next === ']') return result;
        if (next !== ',') return fail();
      }
    }
    for (const [token, result] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const) {
      if (raw.startsWith(token, at)) {
        at += token.length;
        return result;
      }
    }
    const match = /^-?(?:0|[1-9][0-9]*)/.exec(raw.slice(at));
    if (!match) return fail();
    at += match[0].length;
    if (/[.eE]/.test(raw[at] ?? 'x')) return fail();
    const result = Number(match[0]);
    if (!Number.isSafeInteger(result)) return fail();
    return result;
  };
  const result = value(0);
  space();
  if (at !== raw.length) return fail();
  canonicalJson(result);
  return result;
}

export function boundedScalars(text: string): string[] {
  // Check UTF-16 size before allocating the scalar array. Do not strip a BOM or replace invalid surrogates.
  if (text.length > MAX_SOURCE_SCALARS * 2) throw new Error('source-limit');
  canonicalJson(text);
  const scalars = Array.from(text);
  if (scalars.length > MAX_SOURCE_SCALARS) throw new Error('source-limit');
  return scalars;
}

/** A stored UTF-8 artifact retains a leading BOM and rejects malformed bytes. */
export function decodeArtifact(bytes: Uint8Array): string {
  if (bytes.byteLength > MAX_SOURCE_SCALARS * 4) throw new Error('source-limit');
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  boundedScalars(text);
  return text;
}

export { canonicalHash as recordHash, sha256Hex as artifactHash };
