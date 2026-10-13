import { existsSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { evaluate } from '../recommendation-engine/recommendation-engine';
import { evaluationResultSchema, type GeneInput } from '@telesphoros/cpic-schema';
import { KnowledgeLoadError, loadKnowledge } from '../knowledge/knowledge-loader';
import type { KnowledgeSet } from '../knowledge/knowledge-set';
import { PINNED_POPPLER_VERSION } from '../report-reader/pinned-reader';
import type { ReaderResult } from '../report-reader/reader-result';
import { DEFAULT_CLI_PATH, DEFAULT_ENGINE_DIR, SubprocessReportReader } from '../report-reader/subprocess-report-reader';
import type { ReportReader } from '../report-reader/report-reader';
import { adaptReport } from './adapt-report';
import { type AdapterKnowledge, adapterKnowledgeFrom } from './adapter-knowledge';
import { canonicalHash, sha256Hex } from './canonical-json';
import { type CaptureAcceptance, InMemoryCaptureAcceptanceStore } from './capture-acceptance';
import { REPORT_HOLD_ACTIONS, REPORT_HOLD_MESSAGES } from './hold-codes';
import type { AdapterResult } from './types';

// The whole chain, for real: the imported engine through its sidecar, this adapter, then the rules engine, on the twelve
// synthetic development reports and on every combination of the states the specification names. TEST ONLY.
const REPO_ROOT = resolve(__dirname, '../../../../..');
const KNOWLEDGE_DIR = join(REPO_ROOT, 'data/fixtures/knowledge/test-only-reader');
const captureText = (id: string) => readFileSync(join(REPO_ROOT, 'knowledge/lab-report-reader/v2-handoff/fixtures/captures', id, 'report.txt'), 'utf8');

/** A packet or result being edited by hand to forge it. Deliberately untyped: a forger is not bound by the reader's schema. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Forgeable = any;

interface GoldenCase {
  id: string;
  disposition: 'evaluated' | 'held';
  holdCode?: string;
  geneInputs?: GeneInput[];
  notes?: Array<string | null>;
  engine?: Record<string, { outcome: string; reasonCode?: string; strength?: string; recommendationText?: string }>;
}
const golden = (JSON.parse(readFileSync(join(REPO_ROOT, 'tests/report_adapter/golden.json'), 'utf8')) as { cases: GoldenCase[] }).cases;

const TENANT = 'alpha';
const reader = new SubprocessReportReader({ mode: 'non-production' });
const store = new InMemoryCaptureAcceptanceStore();
let knowledgeSet: KnowledgeSet;
let adapterKnowledge: AdapterKnowledge;

beforeAll(async () => {
  knowledgeSet = await loadKnowledge({ directory: KNOWLEDGE_DIR, mode: 'non-production' });
  adapterKnowledge = adapterKnowledgeFrom(knowledgeSet);
});

async function accept(text: string, over: Partial<Parameters<InMemoryCaptureAcceptanceStore['record']>[0]> = {}): Promise<CaptureAcceptance> {
  return store.record({ tenantId: TENANT, textSha256: sha256Hex(text), popplerVersion: PINNED_POPPLER_VERSION, decision: 'accepted', reviewer: { sub: 'test-reviewer', tenantId: TENANT }, note: null, ...over });
}

/** Read a text with the real reader and adapt it, with an acceptance on file unless told otherwise. */
async function full(text: string, tweak?: (result: ReaderResult) => ReaderResult): Promise<AdapterResult> {
  const acceptance = await accept(text);
  const raw = await readFixture(text);
  return adaptReport({ tenantId: TENANT, captureAcceptanceId: acceptance.id, text, reader: tweak ? tweak(structuredClone(raw)) : raw }, { captures: store, knowledge: adapterKnowledge });
}

async function readFixture(text: string, source: ReportReader = reader): Promise<ReaderResult> {
  const first = await source.read(text);
  // Golden assertions exercise content, while deadline enforcement has its own real-process
  // controls. Follow the existing timeout action once; a repeated failure stays a hold and
  // fails the golden. Keep both the engine's and the subprocess's deadlines unchanged.
  if (first.projection.status !== 'held' || first.projection.reason !== 'source-time-budget') return first;
  process.stderr.write('[adapter fixture] Retrying one source-time-budget hold.\n');
  return source.read(text);
}

describe('adapter fixture reader timeouts', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) {
      const marker = join(directory, 'attempt');
      if (existsSync(marker)) unlinkSync(marker);
      rmdirSync(directory);
    }
  });
  // Real process controls: the first CLI launch is delayed, then the same command runs the
  // unchanged sidecar and imported engine. No fabricated successful reader packet is used.
  const delayedReader = (alwaysDelay: boolean) => {
    const directory = mkdtempSync(join(tmpdir(), 'adapter-reader-'));
    directories.push(directory);
    const marker = join(directory, 'attempt');
    const command = [
      'python3', '-I', '-B', '-c',
      'import os, pathlib, sys, time; marker = pathlib.Path(sys.argv[1]); delay = not marker.exists() or sys.argv[4] == "always"; marker.write_text("attempted"); time.sleep(2 if delay else 0); os.execv(sys.executable, [sys.executable, "-I", "-B", sys.argv[2], sys.argv[3], "process"])',
      marker, DEFAULT_CLI_PATH, DEFAULT_ENGINE_DIR, alwaysDelay ? 'always' : 'once',
    ];
    const attempts: ReaderResult[] = [];
    const real = new SubprocessReportReader({ mode: 'non-production', command, deadlineMs: 1_000 });
    const source: ReportReader = { read: async (text) => {
      const result = await real.read(text);
      attempts.push(result);
      return result;
    } };
    return { source, attempts };
  };

  it('retries one real timeout and still meets the hand-written D01 adapter expectation', async () => {
    const { source, attempts } = delayedReader(false);
    const text = captureText('D01');
    const acceptance = await accept(text);
    const raw = await readFixture(text, source);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.projection).toMatchObject({ status: 'held', reason: 'source-time-budget' });
    const result = await adaptReport({ tenantId: TENANT, captureAcceptanceId: acceptance.id, text, reader: raw }, { captures: store, knowledge: adapterKnowledge });
    expect(result.disposition).toBe('evaluated');
    expect(evaluated(result).geneInputs).toEqual(golden.find((c) => c.id === 'D01')!.geneInputs);
  });

  it('stops after a second real timeout and preserves the operational hold', async () => {
    const { source, attempts } = delayedReader(true);
    const result = await readFixture(captureText('D01'), source);
    expect(attempts).toHaveLength(2);
    expect(result.projection).toMatchObject({ status: 'held', reason: 'source-time-budget', payload: null });
  });

  it('does not retry a content hold or a broken worker', async () => {
    for (const command of [['python3', '-I', '-B', DEFAULT_CLI_PATH, DEFAULT_ENGINE_DIR, 'process'], ['python3', '-I', '-B', '-c', 'print("not-json")']]) {
      const attempts: ReaderResult[] = [];
      const real = new SubprocessReportReader({ mode: 'non-production', command });
      const result = await readFixture(captureText('D08'), { read: async (text) => {
        const outcome = await real.read(text);
        attempts.push(outcome);
        return outcome;
      } });
      expect(attempts).toHaveLength(1);
      expect(result.projection.status).toBe('held');
      expect(result.projection.reason).toBe(command.length === 6 ? 'alignment-unsupported' : 'worker-error');
    }
  });
});

const held = (result: AdapterResult) => {
  if (result.disposition !== 'held') throw new Error('expected a hold');
  return result;
};
const evaluated = (result: AdapterResult) => {
  if (result.disposition !== 'evaluated') throw new Error(`expected an evaluation, got hold ${result.code}`);
  return result;
};

describe('the twelve development reports, end to end', () => {
  const results = new Map<string, AdapterResult>();
  beforeAll(async () => {
    for (const c of golden) results.set(c.id, await full(captureText(c.id)));
  }, 60_000);

  it('has an expectation for exactly D01 to D12', () => {
    expect(golden.map((c) => c.id)).toEqual(Array.from({ length: 12 }, (_, i) => `D${String(i + 1).padStart(2, '0')}`));
  });

  it.each(golden.map((c) => [c.id, c] as const))('%s: the adapter produces exactly the expected result', (id, expected) => {
    const result = results.get(id)!;
    expect(result.disposition).toBe(expected.disposition);
    if (expected.disposition === 'held') {
      expect(held(result).code).toBe(expected.holdCode);
      expect(result).not.toHaveProperty('geneInputs');
      return;
    }
    const ok = evaluated(result);
    expect(ok.geneInputs).toEqual(expected.geneInputs);
    expect(ok.occurrences.map((o) => o.note)).toEqual(expected.notes);
  });

  it.each(golden.filter((c) => c.disposition === 'evaluated').map((c) => [c.id, c] as const))('%s: the engine then says what is expected for each test drug', (id, expected) => {
    const output = evaluate(knowledgeSet, evaluated(results.get(id)!).geneInputs, { drugs: ['drugq', 'drugr'] });
    expect(evaluationResultSchema.safeParse(output).success).toBe(true);
    for (const result of output.results) {
      const want = expected.engine![result.drug]!;
      expect({ outcome: result.outcome, reasonCode: 'reasonCode' in result ? result.reasonCode : undefined, strength: 'strength' in result ? result.strength : undefined, recommendationText: 'recommendationText' in result ? result.recommendationText : undefined }).toEqual({
        outcome: want.outcome,
        reasonCode: want.reasonCode,
        strength: want.strength,
        recommendationText: want.recommendationText,
      });
    }
    expect(output.results.map((r) => r.drug)).toEqual(['drugq', 'drugr']);
  });

  it('a held report carries the fixed message and action, a binding, and no drug results', () => {
    for (const id of ['D08', 'D12']) {
      const result = held(results.get(id)!);
      expect(result.message).toBe(REPORT_HOLD_MESSAGES[result.code]);
      expect(result.reviewerAction).toBe(REPORT_HOLD_ACTIONS[result.code]);
      expect(result.binding.textSha256).toBe(sha256Hex(captureText(id)));
      expect(result.binding.popplerVersion).toBe(PINNED_POPPLER_VERSION);
      expect(result.binding.packetHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('repeats keep every occurrence in the audit trail even though the gene has one input', () => {
    const d06 = evaluated(results.get('D06')!);
    expect(d06.occurrences.map((o) => [o.gene, o.occurrenceIndex, o.emitted.length])).toEqual([['CYP2C19', 0, 0], ['CYP2C19', 1, 0]]);
    expect(d06.geneInputs).toEqual([{ gene: 'CYP2C19', state: 'unresolved', reasonCode: 'duplicate-identical' }]);
    expect(d06.geneInputs).toHaveLength(1);
  });

  it('D09 keeps the proportional-table result: both genes tied to their own values', () => {
    const d09 = evaluated(results.get('D09')!);
    expect(d09.occurrences.map((o) => [o.gene, o.roles.diplotype?.start, o.roles.reportedResult?.start])).toEqual([['CYP2C19', 44, 84], ['CYP2B6', 71, 111]]);
  });

  it('is deterministic: the same text gives the same result (apart from which acceptance record it relied on)', async () => {
    const strip = (result: AdapterResult) => JSON.stringify(result).replace(/"captureAcceptanceId":"[^"]+"/, '"captureAcceptanceId":"-"');
    expect(strip(await full(captureText('D01')))).toBe(strip(await full(captureText('D01'))));
  });

  it('never puts text from the report in a hold or in the audit trail (only offsets and hashes)', () => {
    for (const id of ['D08', 'D12']) expect(JSON.stringify(results.get(id))).not.toMatch(/unregistered|Metabolizer|CYP2B6 and/);
    const audit = JSON.stringify(evaluated(results.get('D01')!).occurrences);
    expect(audit).not.toMatch(/Metabolizer|\*1\/\*[12]|diplotype":"|phenotype/);
    expect(audit).toContain(sha256Hex('*1/*2'));
    expect(evaluated(results.get('D01')!).occurrences[0]!.emitted).toEqual([{ state: 'diplotype', reasonCode: null }]);
  });
});

describe('an ambiguous report (values listed with nothing tying them to genes)', () => {
  it('abstains each listed gene once, even if the list names a gene twice, and drops the values', async () => {
    const result = evaluated(await full('Genes: CYP2C19 CYP2C19 CYP2B6\nResults: Poor Metabolizer Normal Metabolizer\n'));
    expect(result.geneInputs).toEqual([
      { gene: 'CYP2C19', state: 'unresolved', reasonCode: 'association-abstained' },
      { gene: 'CYP2B6', state: 'unresolved', reasonCode: 'association-abstained' },
    ]);
    expect(result.occurrences.map((o) => o.note)).toEqual(['abstained', 'abstained']);
    expect(JSON.stringify(result)).not.toContain('Poor Metabolizer');
  });
});

describe('every combination of the states the specification names (full chain)', () => {
  const G = 'CYP2C19';
  type D = 'missing' | 'empty' | 'unmappable' | 'mapped';
  type R = 'missing' | 'empty' | 'equal' | 'different' | 'unavailable' | 'quoted' | 'unfamiliar';
  const dPart: Record<D, string | null> = { missing: null, empty: 'diplotype', unmappable: 'diplotype *1/*Z', mapped: 'diplotype *1/*2' };
  const rPart: Record<R, string | null> = { missing: null, empty: 'result', equal: 'result Intermediate Metabolizer', different: 'result Poor Metabolizer', unavailable: 'result Not Available.', quoted: 'result "not available"', unfamiliar: 'result Indeterminate' };
  const textFor = (d: D, r: R) => `${G}: ${[dPart[d], rPart[r]].filter(Boolean).join('; ')}\n`;

  const other = { gene: G, state: 'unresolved', reasonCode: 'other-gene-unresolved' };
  const dipMapped = { gene: G, state: 'diplotype', diplotype: '*1/*2' };
  const dipBad = { gene: G, state: 'diplotype', diplotype: '*1/*Z' };
  const nul = { gene: G, state: 'null' };
  // Written out by hand from the specification's table, independent of the code under test.
  const expected: Record<string, { inputs: unknown[]; note: string | null }> = {
    'mapped|missing': { inputs: [other], note: 'no-reported-result' },
    'mapped|empty': { inputs: [other], note: 'empty-field' },
    'mapped|equal': { inputs: [dipMapped], note: 'corroborated' },
    'mapped|different': { inputs: [dipMapped, { gene: G, state: 'canonical', phenotype: 'Poor Metabolizer' }], note: 'conflict' },
    'mapped|unavailable': { inputs: [other], note: 'result-untrusted' },
    'mapped|quoted': { inputs: [other], note: 'result-untrusted' },
    'mapped|unfamiliar': { inputs: [other], note: 'result-untrusted' },
    'unmappable|missing': { inputs: [dipBad], note: null },
    'unmappable|empty': { inputs: [dipBad], note: null },
    'unmappable|equal': { inputs: [dipBad], note: null },
    'unmappable|different': { inputs: [dipBad], note: null },
    'unmappable|unavailable': { inputs: [dipBad], note: null },
    'unmappable|quoted': { inputs: [dipBad], note: null },
    'unmappable|unfamiliar': { inputs: [dipBad], note: null },
    'empty|missing': { inputs: [nul], note: 'empty-field' },
    'empty|empty': { inputs: [nul], note: 'empty-field' },
    'empty|equal': { inputs: [other], note: 'empty-field' },
    'empty|different': { inputs: [other], note: 'empty-field' },
    'empty|unavailable': { inputs: [other], note: 'empty-field' },
    'empty|quoted': { inputs: [other], note: 'empty-field' },
    'empty|unfamiliar': { inputs: [other], note: 'empty-field' },
    'missing|missing': { inputs: [other], note: 'nothing-stated' },
    'missing|empty': { inputs: [nul], note: 'empty-field' },
    'missing|equal': { inputs: [{ gene: G, state: 'canonical', phenotype: 'Intermediate Metabolizer' }], note: null },
    'missing|different': { inputs: [{ gene: G, state: 'canonical', phenotype: 'Poor Metabolizer' }], note: null },
    'missing|unavailable': { inputs: [nul], note: 'unavailable' },
    'missing|quoted': { inputs: [other], note: 'result-untrusted' },
    'missing|unfamiliar': { inputs: [other], note: 'result-untrusted' },
  };
  const combos = (Object.keys(dPart) as D[]).flatMap((d) => (Object.keys(rPart) as R[]).map((r) => [d, r] as const));

  it('covers all 28 combinations', () => {
    expect(combos).toHaveLength(28);
    expect(Object.keys(expected).sort()).toEqual(combos.map(([d, r]) => `${d}|${r}`).sort());
  });

  const outcomes = new Map<string, AdapterResult>();
  beforeAll(async () => {
    for (let i = 0; i < combos.length; i += 7) {
      await Promise.all(combos.slice(i, i + 7).map(async ([d, r]) => void outcomes.set(`${d}|${r}`, await full(textFor(d, r)))));
    }
  }, 120_000);

  it.each(combos.map(([d, r]) => [`${d}|${r}`] as const))('%s', (key) => {
    const result = evaluated(outcomes.get(key)!);
    expect(result.geneInputs).toEqual(expected[key]!.inputs);
    expect(result.occurrences).toHaveLength(1);
    expect(result.occurrences[0]!.note).toBe(expected[key]!.note);
  });
});

describe('what the adapter will not accept (every check in the specification, one at a time)', () => {
  const text = captureText('D01');
  let base: ReaderResult;
  let acceptance: CaptureAcceptance;
  const deps = () => ({ captures: store, knowledge: adapterKnowledge });
  const run = (reader: ReaderResult, over: { id?: string; tenantId?: string; text?: string } = {}) => adaptReport({ tenantId: over.tenantId ?? TENANT, captureAcceptanceId: over.id ?? acceptance.id, text: over.text ?? text, reader }, deps());
  /** Rewrites a copy of the packet and seals it again, as a forger who knows the hash rule would. */
  const forge = (mutate: (packet: Forgeable, result: Forgeable) => void): ReaderResult => {
    const result = structuredClone(base) as unknown as Forgeable;
    mutate(result.packet, result);
    const { packetHash: _old, ...rest } = result.packet;
    void _old;
    result.packet.packetHash = canonicalHash(rest);
    result.projection.provenance.packetHash = result.packet.packetHash;
    return result as unknown as ReaderResult;
  };
  const candidateIds = (packet: Forgeable, c: { kind: string; start: number; end: number }) => {
    const contentId = canonicalHash(['pgx-span-content/1', packet.sourceRef.sourceHash, c.kind, c.start, c.end]);
    return { contentId, candidateId: canonicalHash(['pgx-span-build/3', contentId, packet.generatorVersion, packet.generatorCodeHash, packet.grammarHash, packet.offsetContractHash, packet.fieldBoundaryPolicyHash]) };
  };

  beforeAll(async () => {
    base = await reader.read(text);
    acceptance = await accept(text);
  });

  it('accepts the untouched result (the control for everything below)', async () => {
    expect((await run(base)).disposition).toBe('evaluated');
  });

  describe('the capture', () => {
    it('holds when there is no acceptance, when it belongs to another tenant, and when it is a rejection', async () => {
      expect(held(await run(base, { id: 'no-such-record' })).code).toBe('capture-not-accepted');
      expect(held(await run(base, { tenantId: 'beta' })).code).toBe('capture-not-accepted');
      const rejected = await accept(text, { decision: 'rejected', note: 'second look' });
      expect(held(await run(base, { id: rejected.id })).code).toBe('capture-not-accepted');
    });

    it('holds when the accepted text is not the text that was read', async () => {
      const otherAcceptance = await accept('CYP2C19: something else\n');
      expect(held(await run(base, { id: otherAcceptance.id })).code).toBe('capture-hash-mismatch');
    });

    it('holds when the capture was made with any other Poppler version', async () => {
      for (const version of ['24.02.0', '26.03.1', '26.3.0', '25.12']) {
        const other = await accept(text, { popplerVersion: version });
        expect(held(await run(base, { id: other.id })).code).toBe('poppler-version-mismatch');
      }
    });
  });

  describe('the reader build', () => {
    it.each([['generatorVersion', 'stage-a/3'], ['generatorCodeHash', '0'.repeat(64)], ['grammarHash', '0'.repeat(64)], ['offsetContractHash', '0'.repeat(64)], ['fieldBoundaryPolicyHash', '0'.repeat(64)]])('holds when %s is not the pinned one, even if the packet is resealed', async (field, value) => {
      expect(held(await run(forge((packet) => void (packet[field] = value)))).code).toBe('reader-binding-mismatch');
    });
  });

  describe('the packet', () => {
    it('holds when the packet is not for this text', async () => {
      const other = 'CYP2C19: diplotype *1/*1; result Normal Metabolizer\n';
      const otherAcceptance = await accept(other);
      expect(held(await run(base, { id: otherAcceptance.id, text: other })).code).toBe('packet-invalid');
    });

    it.each<[string, (packet: Forgeable, result: Forgeable) => void]>([
      ['a candidate\'s text is changed', (p) => void (p.candidates[0].text = 'CYP2B6')],
      ['a candidate points outside the text', (p) => void (p.candidates[0].end = 99999)],
      ['a candidate identifier is altered', (p) => void (p.candidates[0].candidateId = 'f'.repeat(64))],
      ['a candidate content identifier is altered', (p) => void (p.candidates[0].contentId = 'f'.repeat(64))],
      ['a frame identifier is altered', (p) => void (p.frames[0].frameId = 'f'.repeat(64))],
      ['a frame anchor is moved', (p) => void (p.frames[0].sourceAnchor += 1)],
      ['an edge is removed', (p) => void p.allowedEdges.pop()],
      ['an edge\'s evidence is changed', (p) => void (p.allowedEdges[0].evidence.end += 1)],
      ['a frame is dropped', (p) => void p.frames.pop()],
      ['the declared length is wrong', (p) => void (p.sourceRef.decodedLength += 1)],
      ['the source hash is wrong', (p) => void (p.sourceRef.sourceHash = 'f'.repeat(64))],
      ['the projection loses a span', (_p, r) => void r.projection.payload.spans.pop()],
      ['the projection gains a span', (_p, r) => void r.projection.payload.spans.push({ ...r.projection.payload.spans[0] })],
      ['a projected span moves', (_p, r) => void (r.projection.payload.spans[1].start += 1)],
      ['a projected span names another gene', (_p, r) => void (r.projection.payload.spans[0].gene = 'CYP2B6')],
      ['the verdict contradicts the packet', (_p, r) => void (r.projection.status = 'source-abstained')],
    ])('holds, even when sealed again, if %s', async (_name, mutate) => {
      expect(held(await run(forge(mutate))).code).toBe('packet-invalid');
    });

    it('holds when the packet hash is wrong, when the result is not the reader\'s shape, and when the verdict points at another packet', async () => {
      const wrongHash = structuredClone(base) as unknown as Forgeable;
      wrongHash.packet.packetHash = '0'.repeat(64);
      expect(held(await run(wrongHash as unknown as ReaderResult)).code).toBe('packet-invalid');
      const wrongShape = structuredClone(base) as unknown as Forgeable;
      delete wrongShape.projection;
      expect(held(await run(wrongShape as unknown as ReaderResult)).code).toBe('packet-invalid');
      const otherPacket = structuredClone(base) as unknown as Forgeable;
      otherPacket.projection.provenance.packetHash = '0'.repeat(64);
      expect(held(await run(otherPacket as unknown as ReaderResult)).code).toBe('packet-invalid');
    });

    describe('each integrity check on its own (nothing else in the packet is wrong)', () => {
      // D01's text has free characters between its fields: the ';' at offset 24 belongs to no candidate.
      const addCandidate = (packet: Forgeable, over: { text?: string; contentId?: string; candidateId?: string }) => {
        const extra = { kind: 'diplotype', start: 24, end: 25, text: ';' };
        const ids = candidateIds(packet, extra);
        packet.candidates.push({ ...ids, ...extra, ...over });
      };

      it('the packet hash: a field no other check reads is changed without resealing, and a wrong hash is applied everywhere', async () => {
        const changed = structuredClone(base) as Forgeable;
        changed.packet.limits.max_frames += 1;
        expect(held(await run(changed)).code).toBe('packet-invalid');
        const everywhere = structuredClone(base) as Forgeable;
        everywhere.packet.packetHash = '0'.repeat(64);
        everywhere.projection.provenance.packetHash = '0'.repeat(64);
        expect(held(await run(everywhere)).code).toBe('packet-invalid');
      });

      it('the candidate text: an unreferenced candidate whose text is not the slice it points at', async () => {
        expect(held(await run(forge((p) => addCandidate(p, { text: 'Q' })))).code).toBe('packet-invalid');
        expect((await run(forge((p) => addCandidate(p, {})))).disposition).toBe('evaluated'); // the control: the same candidate with the true text is fine
      });

      it('the candidate identifiers: an unreferenced candidate with a wrong build identifier, and one with a wrong content identifier', async () => {
        expect(held(await run(forge((p) => addCandidate(p, { candidateId: 'f'.repeat(64) })))).code).toBe('packet-invalid');
        expect(held(await run(forge((p) => addCandidate(p, { contentId: 'f'.repeat(64) })))).code).toBe('packet-invalid');
      });

      it('the frame identifier: a frame renamed consistently everywhere, so only its derivation gives it away', async () => {
        const renamed = forge((p) => {
          const old = p.frames[0].frameId;
          p.frames[0].frameId = 'f'.repeat(64);
          for (const edge of p.allowedEdges) if (edge.frameId === old) edge.frameId = 'f'.repeat(64);
        });
        expect(held(await run(renamed)).code).toBe('packet-invalid');
      });
    });

    it('holds when an empty-field diagnostic points at a frame that is not there', async () => {
      const d05 = captureText('D05');
      const acceptance05 = await accept(d05);
      const real = await reader.read(d05);
      const forged = structuredClone(real) as unknown as Forgeable;
      forged.packet.diagnostics.find((d: { kind: string }) => d.kind === 'present-empty-field').frameId = 'f'.repeat(64);
      const { packetHash: _h, ...rest } = forged.packet;
      void _h;
      forged.packet.packetHash = canonicalHash(rest);
      forged.projection.provenance.packetHash = forged.packet.packetHash;
      expect(held(await adaptReport({ tenantId: TENANT, captureAcceptanceId: acceptance05.id, text: d05, reader: forged as ReaderResult }, deps())).code).toBe('packet-invalid');
    });
  });

  describe('disjoint evidence', () => {
    it('holds when a second candidate uses the same characters as the result, even though every hash is valid', async () => {
      const forged = forge((packet) => {
        const result = packet.candidates.find((c: { kind: string }) => c.kind === 'reportedResult');
        const extra = { kind: 'diplotype', start: result.start, end: result.end, text: result.text };
        packet.candidates.push({ ...candidateIds(packet, extra), ...extra });
      });
      expect(held(await run(forged)).code).toBe('evidence-overlap');
    });

    it('holds when one value is claimed by two frames', async () => {
      const d06 = captureText('D06');
      const acceptance06 = await accept(d06);
      const real = await reader.read(d06);
      const forged = structuredClone(real) as unknown as Forgeable;
      const [first, second] = forged.packet.frames;
      const stolen = first.allowed.diplotype[0];
      second.allowed.diplotype.push(stolen);
      forged.packet.allowedEdges.push({ frameId: second.frameId, valueCandidateId: stolen, role: 'diplotype', evidence: { start: 19, end: 24, ruleId: 'named-fields' } });
      const { packetHash: _h, ...rest } = forged.packet;
      void _h;
      forged.packet.packetHash = canonicalHash(rest);
      forged.projection.provenance.packetHash = forged.packet.packetHash;
      expect(held(await adaptReport({ tenantId: TENANT, captureAcceptanceId: acceptance06.id, text: d06, reader: forged as ReaderResult }, deps())).code).toBe('evidence-overlap');
    });
  });

  describe('the reader\'s own verdict', () => {
    it.each([
      ['source-limit'],
      ['candidate-or-frame-limit'],
      ['source-time-budget'],
      ['worker-error'],
    ] as const)('maps the reader\'s failure envelope %s to the hold of the same name', async (reason) => {
      const failure = { packet: { schema: 'pgx-span-processing-failure/1', status: 'held', reason, payload: null }, projection: { status: 'held', reason, payload: null, provenance: { packetHash: null } } } as ReaderResult;
      expect(held(await run(failure)).code).toBe(reason);
    });

    it('holds as invalid when the verdict names a different reason than the packet it came from', async () => {
      const d10 = captureText('D10');
      const acceptance10 = await accept(d10);
      const abstained = structuredClone(await reader.read(d10)) as Forgeable;
      abstained.projection.reason = 'some-other-reason';
      expect(held(await adaptReport({ tenantId: TENANT, captureAcceptanceId: acceptance10.id, text: d10, reader: abstained as ReaderResult }, deps())).code).toBe('packet-invalid');

      const d08 = captureText('D08');
      const acceptance08 = await accept(d08);
      const heldResult = structuredClone(await reader.read(d08)) as Forgeable;
      heldResult.projection.reason = 'unsupported-layout'; // a real reason, but not the packet's
      expect(held(await adaptReport({ tenantId: TENANT, captureAcceptanceId: acceptance08.id, text: d08, reader: heldResult as ReaderResult }, deps())).code).toBe('packet-invalid');
    });

    it('holds as invalid when a failure envelope and its verdict disagree', async () => {
      const failure = { packet: { schema: 'pgx-span-processing-failure/1', status: 'held', reason: 'worker-error', payload: null }, projection: { status: 'held', reason: 'source-limit', payload: null, provenance: { packetHash: null } } } as ReaderResult;
      expect(held(await run(failure)).code).toBe('packet-invalid');
    });

    it.each([
      ['', 'unsupported-layout'],
      ['CYP2C19  CYP2B6\nDiplotype\n*1/*2  *1/*1\n', 'unsupported-column-layout'],
      ['CYP2C19: diplotype *1/*2; result Intermediate Metabolizer\nGenes: CYP2C19 CYP2B6\nResults: Poor Metabolizer Normal Metabolizer\n', 'mixed-frame-set'],
      [captureText('D08'), 'alignment-unsupported'],
      [captureText('D12'), 'unaccounted-text'],
    ])('maps the reader\'s own hold for %j to %s', async (source, code) => {
      expect(held(await full(source)).code).toBe(code);
    });

    it('holds as invalid when a reader hold names a reason the adapter does not know', async () => {
      const d08 = captureText('D08');
      const acceptance08 = await accept(d08);
      const real = await reader.read(d08);
      const forged = structuredClone(real) as unknown as Forgeable;
      forged.packet.reason = 'a-reason-nobody-knows';
      forged.projection.reason = 'a-reason-nobody-knows';
      const { packetHash: _h, ...rest } = forged.packet;
      void _h;
      forged.packet.packetHash = canonicalHash(rest);
      forged.projection.provenance.packetHash = forged.packet.packetHash;
      expect(held(await adaptReport({ tenantId: TENANT, captureAcceptanceId: acceptance08.id, text: d08, reader: forged as ReaderResult }, deps())).code).toBe('packet-invalid');
    });
  });

  it('refuses a text that is not a string, as a programming error', async () => {
    await expect(adaptReport({ tenantId: TENANT, captureAcceptanceId: acceptance.id, text: 5 as unknown as string, reader: base }, deps())).rejects.toThrow(TypeError);
  });

  it('puts no text from the report into any hold, whatever the cause', async () => {
    const results = [await run(base, { id: 'nope' }), await run(forge((p) => void (p.candidates[0].text = 'SECRET-MARKER')))];
    for (const result of results) expect(JSON.stringify(result)).not.toMatch(/SECRET-MARKER|Intermediate|\*1\/\*2/);
  });
});

describe('the test-only knowledge and the hash rule', () => {
  it('the test-only knowledge, which uses real gene symbols, is refused in production', async () => {
    await expect(loadKnowledge({ directory: KNOWLEDGE_DIR, mode: 'production' })).rejects.toThrow(KnowledgeLoadError);
  });

  it('the hash of every real packet is the one the reader itself computed (the two implementations agree)', async () => {
    for (const c of golden) {
      const result = await reader.read(captureText(c.id));
      if (!('packetHash' in result.packet)) continue;
      const { packetHash, ...rest } = result.packet;
      expect(canonicalHash(rest)).toBe(packetHash);
    }
  }, 60_000);
});
