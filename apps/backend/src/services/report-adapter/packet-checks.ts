import { type ReaderPacket, type ReaderResult, type ReaderSpan } from '../report-reader/reader-result';
import { canonicalHash, sha256Hex } from './canonical-json';
import type { OccurrenceFacts } from './adapt-occurrence';

type Candidate = ReaderPacket['candidates'][number];

export interface ParsedOccurrence {
  facts: OccurrenceFacts;
  occurrenceIndex: number;
  diplotypeSpan: Candidate | null;
  resultSpan: Candidate | null;
  emptyRoles: Array<'diplotype' | 'reportedResult'>;
}

export type PacketInspection =
  | { ok: false; code: 'packet-invalid' | 'evidence-overlap' }
  | { ok: true; kind: 'projected'; occurrences: ParsedOccurrence[] }
  | { ok: true; kind: 'abstained'; genes: string[] }
  | { ok: true; kind: 'reader-held'; reason: string | null };

const INVALID = { ok: false, code: 'packet-invalid' } as const;
const OVERLAP = { ok: false, code: 'evidence-overlap' } as const;

const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const spanKey = (s: ReaderSpan) => JSON.stringify([s.gene, s.occurrenceIndex, s.role, s.start, s.end, s.text]);

/**
 * The checks of docs/design/report-adapter-spec.md section 3, steps 4 and 5: does this packet really belong to this text,
 * is it internally consistent, and is the evidence disjoint. Nothing here trusts the reader's own say-so: hashes and
 * identifiers are recomputed, spans are compared with the text, and the projection is re-derived from the packet.
 * Never returns text or values: only a code.
 */
export function inspectPacket(text: string, result: ReaderResult): PacketInspection {
  const packet = result.packet;
  if (packet.schema !== 'pgx-span-candidates/3-draft') return INVALID;
  const scalars = Array.from(text);

  try {
    // 1. The packet hash, and the binding to this exact text.
    const { packetHash, ...rest } = packet;
    if (canonicalHash(rest) !== packetHash) return INVALID;
    if (packet.sourceRef.sourceHash !== sha256Hex(text) || packet.sourceRef.decodedLength !== scalars.length) return INVALID;
    const projection = result.projection;
    if (projection.provenance.packetHash !== packet.packetHash) return INVALID;

    // 2. Every candidate: in range, the exact slice, and the identifiers the reader says it derived.
    const candidates = new Map<string, Candidate>();
    for (const c of packet.candidates) {
      if (c.start >= c.end || c.end > scalars.length || scalars.slice(c.start, c.end).join('') !== c.text) return INVALID;
      if (c.contentId !== canonicalHash(['pgx-span-content/1', packet.sourceRef.sourceHash, c.kind, c.start, c.end])) return INVALID;
      const build = canonicalHash(['pgx-span-build/3', c.contentId, packet.generatorVersion, packet.generatorCodeHash, packet.grammarHash, packet.offsetContractHash, packet.fieldBoundaryPolicyHash]);
      if (c.candidateId !== build || candidates.has(c.candidateId)) return INVALID;
      candidates.set(c.candidateId, c);
    }

    // 3. Frames, and the allowed values of each.
    const frames = new Map<string, ReaderPacket['frames'][number]>();
    for (const f of packet.frames) {
      if (frames.has(f.frameId) || f.frameId !== canonicalHash(['frame/1', f.geneCandidateId, f.ruleId])) return INVALID;
      const gene = candidates.get(f.geneCandidateId);
      if (!gene || gene.kind !== 'gene' || f.sourceAnchor !== gene.start) return INVALID;
      for (const role of ['diplotype', 'reportedResult'] as const) {
        const ids = f.allowed[role];
        if (new Set(ids).size !== ids.length || ids.some((id) => candidates.get(id)?.kind !== role)) return INVALID;
      }
      frames.set(f.frameId, f);
    }

    // 4. The edges are exactly the allowed values, with the evidence of the value itself.
    const expectedEdges = new Set<string>();
    for (const f of packet.frames) for (const role of ['diplotype', 'reportedResult'] as const) for (const id of f.allowed[role]) expectedEdges.add(JSON.stringify([f.frameId, id, role]));
    const seenEdges = new Set<string>();
    for (const e of packet.allowedEdges) {
      const key = JSON.stringify([e.frameId, e.valueCandidateId, e.role]);
      const value = candidates.get(e.valueCandidateId);
      if (seenEdges.has(key) || !expectedEdges.has(key) || !value || e.evidence.start !== value.start || e.evidence.end !== value.end) return INVALID;
      seenEdges.add(key);
    }
    if (seenEdges.size !== expectedEdges.size) return INVALID;

    // 5. Empty-field diagnostics must point at a real frame and a real role.
    const emptyByFrame = new Map<string, Array<'diplotype' | 'reportedResult'>>();
    for (const d of packet.diagnostics) {
      if (d.kind !== 'present-empty-field') continue;
      const { frameId, role } = d as { frameId?: unknown; role?: unknown };
      if (typeof frameId !== 'string' || !frames.has(frameId) || (role !== 'diplotype' && role !== 'reportedResult')) return INVALID;
      emptyByFrame.set(frameId, [...(emptyByFrame.get(frameId) ?? []), role]);
    }

    // 6. Disjoint evidence: no character is evidence for two things.
    const ordered = [...packet.candidates].sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 1; i < ordered.length; i += 1) if (ordered[i]!.start < ordered[i - 1]!.end) return OVERLAP;
    const uses = new Map<string, number>();
    for (const f of packet.frames) for (const id of [...f.allowed.diplotype, ...f.allowed.reportedResult]) uses.set(id, (uses.get(id) ?? 0) + 1);
    if ([...uses.values()].some((n) => n > 1)) return OVERLAP;

    // 7. The reader's own verdict must agree with the packet it came from.
    if (packet.status === 'held') {
      if (projection.status !== 'held' || projection.reason !== packet.reason || projection.payload !== null) return INVALID;
      return { ok: true, kind: 'reader-held', reason: packet.reason };
    }
    if (packet.frameSetState === 'ambiguous') {
      const evidence = (projection.provenance as { unassociatedEvidence?: unknown }).unassociatedEvidence;
      if (projection.status !== 'source-abstained' || projection.reason !== 'registered-source-ambiguity' || packet.frames.length > 0 || packet.ambiguityEvidence.length === 0) return INVALID;
      if (JSON.stringify(projection.payload) !== JSON.stringify({ spans: [], abstain: true })) return INVALID;
      if (!Array.isArray(evidence) || evidence.length !== packet.candidates.length || !evidence.every((e: { candidateId?: string }) => typeof e?.candidateId === 'string' && candidates.has(e.candidateId))) return INVALID;
      const genes = [...new Set(packet.candidates.filter((c) => c.kind === 'gene').map((c) => c.text))];
      return { ok: true, kind: 'abstained', genes };
    }
    if (packet.frameSetState !== 'resolved' || packet.frames.length === 0) return INVALID;
    if (packet.frames.some((f) => f.allowed.diplotype.length > 1 || f.allowed.reportedResult.length > 1)) {
      return projection.status === 'held' && projection.reason === 'selector-quarantined' && projection.payload === null ? { ok: true, kind: 'reader-held', reason: projection.reason } : INVALID;
    }

    // Re-derive the projection from the packet and compare.
    const sorted = [...packet.frames].sort((a, b) => a.sourceAnchor - b.sourceAnchor);
    const perGene = new Map<string, number>();
    const occurrences: ParsedOccurrence[] = [];
    const derived: ReaderSpan[] = [];
    for (const f of sorted) {
      const geneCandidate = candidates.get(f.geneCandidateId)!;
      const gene = geneCandidate.text;
      const index = perGene.get(gene) ?? 0;
      perGene.set(gene, index + 1);
      const d = f.allowed.diplotype[0] ? candidates.get(f.allowed.diplotype[0])! : null;
      const r = f.allowed.reportedResult[0] ? candidates.get(f.allowed.reportedResult[0])! : null;
      const empties = emptyByFrame.get(f.frameId) ?? [];
      for (const c of [geneCandidate, d, r]) if (c) derived.push({ gene, occurrenceIndex: index, role: c.kind, start: c.start, end: c.end, text: c.text });
      occurrences.push({
        facts: {
          gene,
          diplotype: d ? { state: 'present', text: d.text } : empties.includes('diplotype') ? { state: 'empty' } : { state: 'missing' },
          result: r ? { state: 'present', text: r.text } : empties.includes('reportedResult') ? { state: 'empty' } : { state: 'missing' },
        },
        occurrenceIndex: index,
        diplotypeSpan: d,
        resultSpan: r,
        emptyRoles: empties,
      });
    }
    const got = projection.payload?.spans.map(spanKey).sort(byKey);
    if (projection.status !== 'projected' || projection.payload === null || projection.payload.abstain || !got || JSON.stringify(got) !== JSON.stringify(derived.map(spanKey).sort(byKey))) return INVALID;
    return { ok: true, kind: 'projected', occurrences };
  } catch {
    // Anything unexpected while checking is a failed check, never an exception for the caller.
    return INVALID;
  }
}
