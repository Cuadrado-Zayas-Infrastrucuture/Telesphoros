import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PINNED_READER } from './pinned-reader';
import { type ReaderLogger } from './report-reader';
import { type ReaderResult, type ReaderSpan, readerResultSchema } from './reader-result';
import { SubprocessReportReader } from './subprocess-report-reader';

// Runs the REAL hand-off engine through the REAL sidecar (python3) for the twelve synthetic captures. Everything here is TEST ONLY (see
// knowledge/lab-report-reader/v2-handoff/ORIGIN.md). The wrapper's own failure paths, driven with stand-in commands, are in
// subprocess-report-reader.wrapper.spec.ts, which needs no engine.
const REPO_ROOT = resolve(__dirname, '../../../../..');
const captureText = (id: string) => readFileSync(join(REPO_ROOT, 'knowledge/lab-report-reader/v2-handoff/fixtures/captures', id, 'report.txt'), 'utf8');

interface GoldenCase {
  id: string;
  status: 'projected' | 'held' | 'source-abstained';
  reason: string | null;
  spans: ReaderSpan[];
  emptyFieldRoles: string[];
  unassociated?: Array<{ kind: string; start: number; end: number; text: string }>;
}
const golden = (JSON.parse(readFileSync(join(REPO_ROOT, 'tests/report_reader/golden.json'), 'utf8')) as { cases: GoldenCase[] }).cases;

const spanKey = (s: { gene: string; occurrenceIndex: number; role: string; start: number; end: number; text: string }) =>
  `${s.gene}|${s.occurrenceIndex}|${s.role}|${s.start}|${s.end}|${s.text}`;

function recordingLogger() {
  const entries: Array<Record<string, unknown>> = [];
  const logger: ReaderLogger = { warn: (fields) => void entries.push(fields) };
  return { logger, entries, text: () => JSON.stringify(entries) };
}

const reader = (extra: Partial<ConstructorParameters<typeof SubprocessReportReader>[0]> = {}) => new SubprocessReportReader({ mode: 'non-production', ...extra });

describe('the real engine, through the real sidecar, on the twelve captured reports', () => {
  const results = new Map<string, ReaderResult>();
  beforeAll(async () => {
    const r = reader();
    for (const c of golden) results.set(c.id, await r.read(captureText(c.id)));
  }, 60_000);

  it('has a hand-written expectation for exactly D01 to D12', () => {
    expect(golden.map((c) => c.id)).toEqual(Array.from({ length: 12 }, (_, i) => `D${String(i + 1).padStart(2, '0')}`));
  });

  it.each(golden.map((c) => [c.id, c] as const))('%s: status, reason and spans match the hand-written expectation', (id, expected) => {
    const result = results.get(id)!;
    expect(result.projection.status).toBe(expected.status);
    expect(result.projection.reason).toBe(expected.reason);
    const got = (result.projection.payload?.spans ?? []).map(spanKey).sort();
    expect(got).toEqual(expected.spans.map(spanKey).sort());
    expect(result.projection.payload?.abstain ?? false).toBe(expected.status === 'source-abstained');
  });

  it.each(golden.map((c) => [c.id, c] as const))('%s: every span is the exact slice of the text it points at', (id, expected) => {
    const text = [...captureText(id)]; // Unicode scalars, as the engine counts them
    for (const span of results.get(id)!.projection.payload?.spans ?? []) expect(text.slice(span.start, span.end).join('')).toBe(span.text);
    for (const e of expected.unassociated ?? []) expect(text.slice(e.start, e.end).join('')).toBe(e.text); // the expectation itself is consistent with the text
  });

  it.each(golden.map((c) => [c.id, c] as const))('%s: empty fields recorded in the packet are as expected', (id, expected) => {
    const packet = results.get(id)!.packet;
    const diagnostics = 'diagnostics' in packet ? packet.diagnostics : [];
    const empties = diagnostics.filter((d) => d.kind === 'present-empty-field').map((d) => String((d as { role?: unknown }).role));
    expect(empties.sort()).toEqual([...expected.emptyFieldRoles].sort());
  });

  it.each(golden.filter((c) => c.unassociated).map((c) => [c.id, c] as const))(
    '%s: the unassociated genes and results are exactly those expected, and nothing is assigned',
    (id, expected) => {
      const provenance = results.get(id)!.projection.provenance as { unassociatedEvidence?: Array<{ kind: string; start: number; end: number; text: string }> };
      const key = (e: { kind: string; start: number; end: number; text: string }) => `${e.kind}|${e.start}|${e.end}|${e.text}`;
      expect((provenance.unassociatedEvidence ?? []).map(key).sort()).toEqual((expected.unassociated ?? []).map(key).sort());
      expect(results.get(id)!.projection.payload).toEqual({ spans: [], abstain: true });
    },
  );

  it('every packet was built by the pinned reader', () => {
    for (const [id, result] of results) {
      if (!('packetHash' in result.packet)) continue;
      expect({
        id,
        bindings: {
          generatorVersion: result.packet.generatorVersion,
          generatorCodeHash: result.packet.generatorCodeHash,
          grammarHash: result.packet.grammarHash,
          offsetContractHash: result.packet.offsetContractHash,
          fieldBoundaryPolicyHash: result.packet.fieldBoundaryPolicyHash,
        },
      }).toEqual({ id, bindings: PINNED_READER });
    }
  });

  it('D08 stays held: the pinned capture lost a column gap, and the reader refuses to guess', () => {
    expect(results.get('D08')!.projection).toMatchObject({ status: 'held', reason: 'alignment-unsupported', payload: null });
  });

  it('is deterministic: the same text gives byte-identical output', async () => {
    const again = await reader().read(captureText('D09'));
    expect(JSON.stringify(again)).toBe(JSON.stringify(results.get('D09')));
  });

  it('returns results that satisfy the strict schema', () => {
    for (const result of results.values()) expect(readerResultSchema.safeParse(result).success).toBe(true);
  });
});

describe('the pinned reader', () => {
  it('is the engine that is on disk (recomputed by the engine itself, not copied)', async () => {
    expect(await reader().bindings()).toEqual(PINNED_READER);
    expect(await reader().verifyPinned()).toEqual([]);
  });
});

describe('what the reader will and will not run', () => {
  it('lets the engine apply its exact limit (100 000 Unicode scalars) to a text under the cheap bound', async () => {
    const result = await reader().read('a'.repeat(100_001));
    expect(result.projection).toMatchObject({ status: 'held', reason: 'source-limit' });
  });

  it("holds, with the engine's class name only, on text that is not valid Unicode (a lone surrogate)", async () => {
    const log = recordingLogger();
    const result = await reader({ logger: log.logger }).read('CYP2C19: \ud800');
    expect(result.projection).toMatchObject({ status: 'held', reason: 'worker-error' });
    expect(log.entries[0]).toMatchObject({ event: 'report-reader-failure', cause: 'exit', readerError: 'Invalid' });
    // The wrapper's own frames survive the safety filter: plain "name:line" entries, no message text.
    expect(log.entries[0]!.frames).toEqual(expect.arrayContaining([expect.stringMatching(/^main:\d+$/)]));
    expect(log.text()).not.toContain('ud800');
  });
});
