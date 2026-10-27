import { canonicalHash, sha256Hex } from '../../src/services/report-adapter/canonical-json';
import { PINNED_READER } from '../../src/services/report-reader/pinned-reader';
import type { ReaderResult, ReaderSpan } from '../../src/services/report-reader/reader-result';
import type { ReportReader } from '../../src/services/report-reader/report-reader';

/**
 * A TEST STAND-IN for the report reader. TEST ONLY: it lives under test/ and nothing in src/ may import it (a test pins that).
 *
 * The real reader (an imported engine run as a subprocess) is not part of this repository. This double reads the small, line-based format of the
 * synthetic fixtures in data/fixtures/lab-reports and returns what the real reader's contract requires: a packet whose hashes, identifiers,
 * offsets and edges the adapter recomputes (src/services/report-adapter/packet-checks.ts), and the projection derived from it. It exists so the
 * adapter, the rules engine, the records and everything after them can be tested end to end. It says NOTHING about the real reader.
 *
 * To be accepted by the adapter it must carry the pinned build bindings; that is a property of this double, not a claim about any engine.
 *
 * Format (one gene per line, fields separated by " | "; an empty value after a label is an empty field):
 *   Gene: CYP2C19 | Diplotype: *1/*2 | Result: Intermediate Metabolizer
 * Anything else is ignored, except: `Layout: unaligned-columns` holds the report (alignment-unsupported), a `Gene:` line that does not parse holds it
 * (unaccounted-text), and a report with no gene line holds it (unsupported-layout).
 *
 * `Layout: unassociated-values` is a second, list-based layout: values are listed with nothing that ties one to a gene, so the reader abstains
 * (registered-source-ambiguity) and lists every candidate as unassociated evidence. Its lines are `Genes:`, `Diplotypes:` and `Results:`, each a
 * " | "-separated list; a `Gene:` line, or no `Genes:` line, holds the report (unaccounted-text).
 */
export class StandInReportReader implements ReportReader {
  async read(text: string): Promise<ReaderResult> {
    return standInRead(text);
  }
}

type Role = 'gene' | 'diplotype' | 'reportedResult';
interface Candidate {
  contentId: string;
  candidateId: string;
  kind: Role;
  start: number;
  end: number;
  text: string;
}
interface Found {
  role: Role;
  start: number;
  end: number;
  text: string;
}

const RULE_ID = 'stand-in-line/1';
const LABELS = { Gene: 'gene', Diplotype: 'diplotype', Result: 'reportedResult' } as const;

const scalarIndex = (text: string, utf16Index: number) => Array.from(text.slice(0, utf16Index)).length;

function baseFields(text: string) {
  return {
    ...PINNED_READER,
    sourceRef: { sourceHash: sha256Hex(text), decodedLength: Array.from(text).length },
  };
}

function held(text: string, reason: string): ReaderResult {
  const rest = {
    schema: 'pgx-span-candidates/3-draft' as const,
    status: 'held' as const,
    reason,
    frameSetState: 'unclassified' as const,
    ...baseFields(text),
    candidates: [],
    frames: [],
    allowedEdges: [],
    diagnostics: [],
    ambiguityEvidence: [],
  };
  const packetHash = canonicalHash(rest);
  return { packet: { ...rest, packetHash }, projection: { status: 'held', reason, payload: null, provenance: { packetHash } } };
}

/** One gene line to its fields, with scalar offsets into the whole text, or null when the line is not a well-formed gene line. */
function parseGeneLine(line: string, lineStart: number): { fields: Found[]; empty: Role[] } | null {
  const fields: Found[] = [];
  const empty: Role[] = [];
  let cursor = 0;
  for (const part of line.split(' | ')) {
    const at = line.indexOf(part, cursor);
    cursor = at + part.length;
    const colon = part.indexOf(':');
    const label = colon < 0 ? '' : part.slice(0, colon);
    const role = (LABELS as Record<string, Role | undefined>)[label];
    if (!role) return null;
    const raw = part.slice(colon + 1);
    const value = raw.trim();
    if (value === '') {
      empty.push(role);
      continue;
    }
    const valueAt = at + colon + 1 + raw.indexOf(value);
    const start = lineStart + scalarIndex(line, valueAt);
    fields.push({ role, start, end: start + Array.from(value).length, text: value });
  }
  if (!fields.some((f) => f.role === 'gene')) return null;
  return { fields, empty };
}

const LIST_LABELS = { 'Genes:': 'gene', 'Diplotypes:': 'diplotype', 'Results:': 'reportedResult' } as const;

/** The list layout: every listed value is a candidate, no frame ties any of them to a gene, and the projection abstains. */
function unassociatedRead(text: string): ReaderResult {
  const base = baseFields(text);
  const candidates: Candidate[] = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    const lineStart = offset;
    offset += Array.from(line).length + 1;
    if (line.startsWith('Gene:')) return held(text, 'unaccounted-text');
    const label = (Object.keys(LIST_LABELS) as Array<keyof typeof LIST_LABELS>).find((l) => line.startsWith(l));
    if (!label) continue;
    let cursor = label.length;
    for (const part of line.slice(label.length).split(' | ')) {
      const at = line.indexOf(part, cursor);
      cursor = at + part.length;
      const value = part.trim();
      if (value === '') return held(text, 'unaccounted-text');
      const start = lineStart + scalarIndex(line, at + part.indexOf(value));
      const found = { role: LIST_LABELS[label], start, end: start + Array.from(value).length, text: value };
      const contentId = canonicalHash(['pgx-span-content/1', base.sourceRef.sourceHash, found.role, found.start, found.end]);
      const candidateId = canonicalHash([
        'pgx-span-build/3',
        contentId,
        base.generatorVersion,
        base.generatorCodeHash,
        base.grammarHash,
        base.offsetContractHash,
        base.fieldBoundaryPolicyHash,
      ]);
      candidates.push({ contentId, candidateId, kind: found.role, start: found.start, end: found.end, text: found.text });
    }
  }
  if (!candidates.some((c) => c.kind === 'gene')) return held(text, 'unaccounted-text');
  const rest = {
    schema: 'pgx-span-candidates/3-draft' as const,
    status: 'ready' as const,
    reason: null,
    frameSetState: 'ambiguous' as const,
    ...base,
    candidates,
    frames: [],
    allowedEdges: [],
    diagnostics: [],
    ambiguityEvidence: [{ kind: 'unassociated-values', candidateIds: candidates.map((c) => c.candidateId) }],
  };
  const packetHash = canonicalHash(rest);
  return {
    packet: { ...rest, packetHash },
    projection: {
      status: 'source-abstained',
      reason: 'registered-source-ambiguity',
      payload: { spans: [], abstain: true },
      provenance: { packetHash, unassociatedEvidence: candidates.map((c) => ({ candidateId: c.candidateId })) },
    },
  };
}

export function standInRead(text: string): ReaderResult {
  if (text.split('\n').some((line) => line.startsWith('Layout:') && line.slice('Layout:'.length).trim() === 'unassociated-values')) return unassociatedRead(text);
  const base = baseFields(text);
  const candidates: Candidate[] = [];
  const frames: Array<{ frameId: string; geneCandidateId: string; sourceAnchor: number; ruleId: string; allowed: { diplotype: string[]; reportedResult: string[] } }> = [];
  const edges: Array<{ frameId: string; valueCandidateId: string; role: 'diplotype' | 'reportedResult'; evidence: { start: number; end: number; ruleId: string } }> = [];
  const diagnostics: Array<{ kind: string; frameId: string; role: Role }> = [];
  const spans: ReaderSpan[] = [];
  const perGene = new Map<string, number>();

  const candidate = (found: Found): Candidate => {
    const contentId = canonicalHash(['pgx-span-content/1', base.sourceRef.sourceHash, found.role, found.start, found.end]);
    const candidateId = canonicalHash([
      'pgx-span-build/3',
      contentId,
      base.generatorVersion,
      base.generatorCodeHash,
      base.grammarHash,
      base.offsetContractHash,
      base.fieldBoundaryPolicyHash,
    ]);
    const made = { contentId, candidateId, kind: found.role, start: found.start, end: found.end, text: found.text };
    candidates.push(made);
    return made;
  };

  let offset = 0;
  for (const line of text.split('\n')) {
    const lineStart = offset;
    offset += Array.from(line).length + 1;
    if (line.startsWith('Layout:') && line.slice('Layout:'.length).trim() === 'unaligned-columns') return held(text, 'alignment-unsupported');
    if (!line.startsWith('Gene:')) continue;
    const parsed = parseGeneLine(line, lineStart);
    if (!parsed) return held(text, 'unaccounted-text');
    const gene = candidate(parsed.fields.find((f) => f.role === 'gene')!);
    const diplotype = parsed.fields.find((f) => f.role === 'diplotype');
    const result = parsed.fields.find((f) => f.role === 'reportedResult');
    const d = diplotype ? candidate(diplotype) : null;
    const r = result ? candidate(result) : null;
    const frameId = canonicalHash(['frame/1', gene.candidateId, RULE_ID]);
    frames.push({
      frameId,
      geneCandidateId: gene.candidateId,
      sourceAnchor: gene.start,
      ruleId: RULE_ID,
      allowed: { diplotype: d ? [d.candidateId] : [], reportedResult: r ? [r.candidateId] : [] },
    });
    for (const [role, value] of [
      ['diplotype', d],
      ['reportedResult', r],
    ] as const) {
      if (value) edges.push({ frameId, valueCandidateId: value.candidateId, role, evidence: { start: value.start, end: value.end, ruleId: RULE_ID } });
    }
    for (const role of parsed.empty) if (role === 'diplotype' || role === 'reportedResult') diagnostics.push({ kind: 'present-empty-field', frameId, role });
    const index = perGene.get(gene.text) ?? 0;
    perGene.set(gene.text, index + 1);
    for (const c of [gene, d, r]) if (c) spans.push({ gene: gene.text, occurrenceIndex: index, role: c.kind, start: c.start, end: c.end, text: c.text });
  }
  if (frames.length === 0) return held(text, 'unsupported-layout');

  const rest = {
    schema: 'pgx-span-candidates/3-draft' as const,
    status: 'ready' as const,
    reason: null,
    frameSetState: 'resolved' as const,
    ...base,
    candidates,
    frames,
    allowedEdges: edges,
    diagnostics,
    ambiguityEvidence: [],
  };
  const packetHash = canonicalHash(rest);
  return { packet: { ...rest, packetHash }, projection: { status: 'projected', reason: null, payload: { spans, abstain: false }, provenance: { packetHash } } };
}
