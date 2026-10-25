import { createHash } from 'node:crypto';
import { candidateSchema, sourceSchema, verdictSchema, utf8Length, type Candidate, type Context, type Source } from './contracts';

export const hashBytes = (bytes: string | Uint8Array): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
export function checkSources(values: unknown[], context: Context): Source[] {
  if (!values.length || values.length > 4) throw new Error('EVIDENCE_INVALID');
  const sources = values.map((v) => sourceSchema.parse(v));
  if (new Set(sources.map((s) => s.id)).size !== sources.length || sources.reduce((n, s) => n + utf8Length(s.body), 0) > 16384) throw new Error('EVIDENCE_INVALID');
  for (const s of sources) {
    const binding = context.sources.find((b) => b.id === s.id);
    if (s.tenantId !== context.tenantId || !binding || binding.version !== s.version || binding.digest !== s.digest || hashBytes(s.body) !== s.digest)
      throw new Error('EVIDENCE_INVALID');
  }
  return sources.map((s) => Object.freeze(s));
}
// Tuple encoding only: exact validated fields, no general canonical JSON algorithm.
export const evidenceIdentity = (sources: Source[]): string => hashBytes(JSON.stringify(sources.map((s) => [s.id, s.version, s.digest])));
export function checkCandidate(value: unknown, sources: Source[]): Candidate {
  const c = candidateSchema.parse(value);
  if (hashBytes(c.text) !== c.digest || c.text !== c.claims.map((x) => x.text).join('\n') || new Set(c.claims.map((x) => x.id)).size !== c.claims.length)
    throw new Error('MECHANICAL_HOLD');
  for (const claim of c.claims) {
    const s = sources.find((x) => x.id === claim.sourceId);
    if (!s) throw new Error('MECHANICAL_HOLD');
    const bytes = new TextEncoder().encode(s.body);
    const { startByte: start, endByte: end } = claim;
    if (start >= end || end > bytes.length || (start < bytes.length && (bytes[start] & 0xc0) === 0x80) || (end < bytes.length && (bytes[end] & 0xc0) === 0x80))
      throw new Error('MECHANICAL_HOLD');
    if (new TextDecoder('utf-8', { fatal: true }).decode(bytes.slice(start, end)) !== claim.text) throw new Error('MECHANICAL_HOLD');
  }
  c.claims.forEach(Object.freeze);
  Object.freeze(c.claims);
  return Object.freeze(c);
}
export function checkVerdict(value: unknown, candidate: Candidate, evidenceDigest: string) {
  const v = verdictSchema.parse(value);
  if (v.candidateDigest !== candidate.digest || v.evidenceDigest !== evidenceDigest) throw new Error('REVIEW_BINDING');
  const ids = new Set(v.claimVerdicts.map((x) => x.claimId));
  if (ids.size !== candidate.claims.length || v.claimVerdicts.length !== ids.size || candidate.claims.some((c) => !ids.has(c.id)) || v.claimVerdicts.some((c) => !c.supported))
    throw new Error('CLAIM_COVERAGE');
  return v;
}
