import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { evaluationResultSchema, type GeneInput } from '@telesphoros/cpic-schema';
import { FakeTextCaptureRunner } from '../src/lab-reports/runner/fake-text-capture-runner';
import { StructuralValidator } from '../src/reports/intake/structural-validator';
import { adaptReport } from '../src/services/report-adapter/adapt-report';
import { type AdapterKnowledge, adapterKnowledgeFrom } from '../src/services/report-adapter/adapter-knowledge';
import { canonicalHash, sha256Hex } from '../src/services/report-adapter/canonical-json';
import { InMemoryCaptureAcceptanceStore } from '../src/services/report-adapter/capture-acceptance';
import type { AdapterResult } from '../src/services/report-adapter/types';
import { loadKnowledge } from '../src/services/knowledge/knowledge-loader';
import type { KnowledgeSet } from '../src/services/knowledge/knowledge-set';
import { evaluate } from '../src/services/recommendation-engine/recommendation-engine';
import { PINNED_POPPLER_VERSION } from '../src/services/report-reader/pinned-reader';
import type { ReaderResult } from '../src/services/report-reader/reader-result';
import { TEST_KNOWLEDGE } from './helpers/lab-pipeline';
import { StandInReportReader, standInRead } from './helpers/stand-in-reader';

// The public synthetic fixtures and the test stand-in reader, end to end through the real adapter and the real rules engine, against the
// hand-written oracle. TEST ONLY. This file must run with or without the imported reader engine.
const REPO_ROOT = resolve(__dirname, '../../..');
const PUBLIC_FIXTURES = join(REPO_ROOT, 'data/fixtures/lab-reports/captures');
const IDS = ['D01', 'D02', 'D08'] as const;
interface GoldenCase { id: string; disposition: 'evaluated' | 'held'; holdCode?: string; geneInputs?: GeneInput[]; notes?: Array<string | null>;
  engine?: Record<string, { outcome: string; reasonCode?: string; strength?: string; recommendationText?: string }> }
const golden = (JSON.parse(readFileSync(join(REPO_ROOT, 'tests/report_adapter/golden.json'), 'utf8')) as { cases: GoldenCase[] }).cases;
const text = (id: string) => readFileSync(join(PUBLIC_FIXTURES, id, 'report.txt'), 'utf8');
const bare = (inputs: object[]) => inputs.map((i) => { const copy: Record<string, unknown> = { ...i }; delete copy.callSource; return copy; });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Forgeable = any;

const TENANT = 'alpha';
const store = new InMemoryCaptureAcceptanceStore();
let knowledgeSet: KnowledgeSet;
let adapterKnowledge: AdapterKnowledge;
beforeAll(async () => {
  knowledgeSet = await loadKnowledge({ directory: TEST_KNOWLEDGE, mode: 'non-production' });
  adapterKnowledge = adapterKnowledgeFrom(knowledgeSet);
});
async function adapt(source: string, reader: ReaderResult): Promise<AdapterResult> {
  const acceptance = await store.record({ tenantId: TENANT, textSha256: sha256Hex(source), popplerVersion: PINNED_POPPLER_VERSION, decision: 'accepted', reviewer: { sub: 'test-reviewer', tenantId: TENANT }, note: null });
  return adaptReport({ tenantId: TENANT, captureAcceptanceId: acceptance.id, text: source, reader }, { captures: store, knowledge: adapterKnowledge });
}

describe('the public synthetic fixtures', () => {
  it('are what their generator builds (no drift, no extra files)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const generator = require('../../../scripts/test-fixtures/lab-report-fixtures.cjs') as { build(): Map<string, Buffer>; check(files: Map<string, Buffer>): string[] };
    expect(generator.check(generator.build())).toEqual([]);
  });

  it('open in the recorded-text capture runner, which answers for each PDF by its hash', async () => {
    const runner = await FakeTextCaptureRunner.open(PUBLIC_FIXTURES);
    for (const id of IDS) {
      const capture = await runner.capture(readFileSync(join(PUBLIC_FIXTURES, id, 'source.pdf')));
      expect(capture.text).toBe(text(id));
      expect(capture.popplerVersion).toBe(PINNED_POPPLER_VERSION);
    }
  });

  it('pass the intake structural check for a lab PDF', () => {
    for (const id of IDS) {
      const validator = new StructuralValidator('lab-pdf');
      validator.feed(readFileSync(join(PUBLIC_FIXTURES, id, 'source.pdf')));
      expect(() => validator.finish()).not.toThrow();
    }
  });

  it('carry no real-looking identifiers and say that they are synthetic', () => {
    for (const id of IDS) expect(text(id)).toMatch(/SYNTHETIC/);
  });
});

describe('the stand-in reader through the real adapter and engine', () => {
  const reader = new StandInReportReader();

  it.each(golden.filter((c) => (IDS as readonly string[]).includes(c.id)).map((c) => [c.id, c] as const))('%s: the adapter does what the oracle says', async (id, expected) => {
    const result = await adapt(text(id), await reader.read(text(id)));
    expect(result.disposition).toBe(expected.disposition);
    if (expected.disposition === 'held') {
      expect(result).toMatchObject({ disposition: 'held', code: expected.holdCode });
      return;
    }
    if (result.disposition !== 'evaluated') throw new Error('expected an evaluated report');
    expect(bare(result.geneInputs)).toEqual(expected.geneInputs);
    expect(result.occurrences.map((o) => o.note)).toEqual(expected.notes);
    expect(result.geneInputs.every((i) => i.callSource === 'lab-report')).toBe(true);
  });

  it.each(golden.filter((c) => c.disposition === 'evaluated' && (IDS as readonly string[]).includes(c.id)).map((c) => [c.id, c] as const))('%s: the engine then says what the oracle expects for each test drug', async (id, expected) => {
    const result = await adapt(text(id), await reader.read(text(id)));
    if (result.disposition !== 'evaluated') throw new Error('expected an evaluated report');
    const output = evaluate(knowledgeSet, result.geneInputs, { drugs: ['drugq', 'drugr'] });
    expect(evaluationResultSchema.safeParse(output).success).toBe(true);
    for (const r of output.results) {
      const want = expected.engine![r.drug]!;
      expect({ outcome: r.outcome, reasonCode: 'reasonCode' in r ? r.reasonCode : undefined, strength: 'strength' in r ? r.strength : undefined,
        recommendationText: 'recommendationText' in r ? r.recommendationText : undefined })
        .toEqual({ outcome: want.outcome, reasonCode: want.reasonCode, strength: want.strength, recommendationText: want.recommendationText });
    }
    expect(output.results.map((r) => r.drug)).toEqual(['drugq', 'drugr']);
  });

  describe('controls: the adapter still refuses what a stand-in would be tempted to pass', () => {
    const forge = (source: string, mutate: (packet: Forgeable, result: Forgeable) => void, reseal = true): ReaderResult => {
      const result = structuredClone(standInRead(source)) as Forgeable;
      mutate(result.packet, result);
      if (reseal) {
        const { packetHash: _old, ...rest } = result.packet;
        void _old;
        result.packet.packetHash = canonicalHash(rest);
        result.projection.provenance.packetHash = result.packet.packetHash;
      }
      return result as ReaderResult;
    };

    it('the unmodified output of the stand-in is accepted (positive control)', async () => {
      expect((await adapt(text('D01'), standInRead(text('D01')))).disposition).toBe('evaluated');
    });

    it('a packet edited without resealing is refused as invalid', async () => {
      const edited = forge(text('D01'), (packet) => { packet.candidates[0].text = 'CYP2C9'; }, false);
      expect(await adapt(text('D01'), edited)).toMatchObject({ disposition: 'held', code: 'packet-invalid' });
    });

    it('a resealed packet whose spans no longer match the text is refused as invalid', async () => {
      const edited = forge(text('D01'), (packet) => { packet.candidates[0].start += 1; packet.candidates[0].end += 1; });
      expect(await adapt(text('D01'), edited)).toMatchObject({ disposition: 'held', code: 'packet-invalid' });
    });

    it('a packet from a build that is not the pinned one is refused', async () => {
      const edited = forge(text('D01'), (packet) => { packet.generatorCodeHash = '0'.repeat(64); });
      expect(await adapt(text('D01'), edited)).toMatchObject({ disposition: 'held', code: 'reader-binding-mismatch' });
    });

    it('a packet read from other text is refused as invalid', async () => {
      expect(await adapt(text('D01'), standInRead(text('D02')))).toMatchObject({ disposition: 'held', code: 'packet-invalid' });
    });

    it('text it does not understand is held with a named reader reason, not guessed', () => {
      expect(standInRead('nothing to read here\n').projection).toMatchObject({ status: 'held', reason: 'unsupported-layout' });
      expect(standInRead('Gene: | Diplotype: *1/*1\n').projection).toMatchObject({ status: 'held', reason: 'unaccounted-text' });
    });
  });
});

describe('test code stays out of the product', () => {
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
  it('nothing under src imports the stand-in reader or the test helpers', () => {
    const offenders = walk(join(__dirname, '../src')).filter((f) => /\.(ts|cjs|js)$/.test(f) && !/\.spec\.ts$/.test(f) && /stand-in-reader|test\/helpers/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
