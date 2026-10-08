import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PINNED_READER } from './pinned-reader';
import { type ReaderLogger, ReaderNotApprovedError } from './report-reader';
import { type ReaderResult, type ReaderSpan, readerResultSchema } from './reader-result';
import { SubprocessReportReader } from './subprocess-report-reader';

// Runs the REAL hand-off engine through the REAL sidecar (python3) for the twelve synthetic captures, and drives the
// failure paths with stand-in commands. Everything here is TEST ONLY (see knowledge/lab-report-reader/v2-handoff/ORIGIN.md).
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

const spanKey = (s: { gene: string; occurrenceIndex: number; role: string; start: number; end: number; text: string }) => `${s.gene}|${s.occurrenceIndex}|${s.role}|${s.start}|${s.end}|${s.text}`;

function recordingLogger() {
  const entries: Array<Record<string, unknown>> = [];
  const logger: ReaderLogger = { warn: (fields) => void entries.push(fields) };
  return { logger, entries, text: () => JSON.stringify(entries) };
}

const reader = (extra: Partial<ConstructorParameters<typeof SubprocessReportReader>[0]> = {}) => new SubprocessReportReader({ mode: 'non-production', ...extra });
const sh = (script: string) => ['sh', '-c', script];

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

  it.each(golden.filter((c) => c.unassociated).map((c) => [c.id, c] as const))('%s: the unassociated genes and results are exactly those expected, and nothing is assigned', (id, expected) => {
    const provenance = results.get(id)!.projection.provenance as { unassociatedEvidence?: Array<{ kind: string; start: number; end: number; text: string }> };
    const key = (e: { kind: string; start: number; end: number; text: string }) => `${e.kind}|${e.start}|${e.end}|${e.text}`;
    expect((provenance.unassociatedEvidence ?? []).map(key).sort()).toEqual((expected.unassociated ?? []).map(key).sort());
    expect(results.get(id)!.projection.payload).toEqual({ spans: [], abstain: true });
  });

  it('every packet was built by the pinned reader', () => {
    for (const [id, result] of results) {
      if (!('packetHash' in result.packet)) continue;
      expect({ id, bindings: { generatorVersion: result.packet.generatorVersion, generatorCodeHash: result.packet.generatorCodeHash, grammarHash: result.packet.grammarHash, offsetContractHash: result.packet.offsetContractHash, fieldBoundaryPolicyHash: result.packet.fieldBoundaryPolicyHash } }).toEqual({ id, bindings: PINNED_READER });
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

  it('names a binding that differs and never prints a value', async () => {
    const changed = { ...PINNED_READER, generatorCodeHash: '0'.repeat(64) };
    const r = reader({ command: sh(`printf '%s' '${JSON.stringify(changed)}'`) });
    expect(await r.verifyPinned()).toEqual(['generatorCodeHash']);
  });
});

describe('what the reader will and will not run', () => {
  it('refuses to be created in production: the engine is authorized for offline construction only', () => {
    expect(() => new SubprocessReportReader({ mode: 'production' })).toThrow(ReaderNotApprovedError);
  });

  it('rejects anything that is not a string', async () => {
    await expect(reader().read(5 as unknown as string)).rejects.toThrow(TypeError);
  });

  it('never spawns for a text that cannot be within the engine limit (checked before anything is sent)', async () => {
    const marker = join(mkdtempSync(join(tmpdir(), 'reader-')), 'spawned');
    const r = reader({ command: sh(`touch ${marker}`) });
    const result = await r.read('a'.repeat(200_001));
    expect(result.projection).toMatchObject({ status: 'held', reason: 'source-limit' });
    expect(existsSync(marker)).toBe(false);
  });

  it('lets the engine apply its exact limit (100 000 Unicode scalars) to a text under the cheap bound', async () => {
    const result = await reader().read('a'.repeat(100_001));
    expect(result.projection).toMatchObject({ status: 'held', reason: 'source-limit' });
  });

  it('holds, with the engine\'s class name only, on text that is not valid Unicode (a lone surrogate)', async () => {
    const log = recordingLogger();
    const result = await reader({ logger: log.logger }).read('CYP2C19: \ud800');
    expect(result.projection).toMatchObject({ status: 'held', reason: 'worker-error' });
    expect(log.entries[0]).toMatchObject({ event: 'report-reader-failure', cause: 'exit', readerError: 'Invalid' });
    // The wrapper's own frames survive the safety filter: plain "name:line" entries, no message text.
    expect(log.entries[0]!.frames).toEqual(expect.arrayContaining([expect.stringMatching(/^main:\d+$/)]));
    expect(log.text()).not.toContain('ud800');
  });
});

describe('a misbehaving subprocess becomes a hold, never a hang, a crash, or a leak', () => {
  it('kills the whole process tree at the deadline, including a child that ignores SIGTERM', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reader-'));
    const pidFile = join(dir, 'child.pid');
    // The shell traps SIGTERM and starts a grandchild: only a group SIGKILL ends both.
    const r = reader({ command: sh(`trap '' TERM; sleep 60 & echo $! > ${pidFile}; while :; do sleep 1; done`), deadlineMs: 400, killGraceMs: 300 });
    const started = Date.now();
    const result = await r.read('x');
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.projection).toMatchObject({ status: 'held', reason: 'source-time-budget' });
    const grandchild = Number(readFileSync(pidFile, 'utf8').trim());
    const alive = () => { try { process.kill(grandchild, 0); return true; } catch { return false; } };
    for (let i = 0; i < 40 && alive(); i += 1) await new Promise((r2) => setTimeout(r2, 50));
    expect(alive()).toBe(false);
  }, 15_000);

  it('stops reading at the output cap and holds', async () => {
    const log = recordingLogger();
    const r = reader({ command: sh(`head -c 3000000 /dev/zero | tr '\\0' x`), maxOutputBytes: 1_000_000, logger: log.logger });
    expect((await r.read('x')).projection).toMatchObject({ status: 'held', reason: 'worker-error' });
    expect(log.entries[0]).toMatchObject({ cause: 'output-limit' });
  });

  it('holds on output that is not JSON, or JSON of the wrong shape, and logs only where it was wrong', async () => {
    const notJson = recordingLogger();
    expect((await reader({ command: sh('echo not-json'), logger: notJson.logger }).read('x')).projection.reason).toBe('worker-error');
    expect(notJson.entries[0]).toMatchObject({ cause: 'output-not-json' });
    const wrongShape = recordingLogger();
    expect((await reader({ command: sh(`echo '{"packet":1,"projection":2}'`), logger: wrongShape.logger }).read('x')).projection.reason).toBe('worker-error');
    expect(wrongShape.entries[0]).toMatchObject({ cause: 'output-shape', invalidAt: expect.arrayContaining(['packet']) });
  });

  it('holds when the command cannot be started', async () => {
    const log = recordingLogger();
    expect((await reader({ command: ['/nonexistent/reader'], logger: log.logger }).read('x')).projection.reason).toBe('worker-error');
    expect(log.entries[0]).toMatchObject({ cause: 'spawn-failed' });
  });

  it('logs the exit code, the signal and the size of stderr, but never the report text, even when the process echoes it', async () => {
    const log = recordingLogger();
    const marker = 'SECRET-REPORT-MARKER-5150';
    const r = reader({ command: sh('cat >&2; exit 3'), logger: log.logger });
    expect((await r.read(`CYP2C19: ${marker}`)).projection.reason).toBe('worker-error');
    expect(log.entries[0]).toMatchObject({ event: 'report-reader-failure', cause: 'exit', exitCode: 3 });
    expect(Number(log.entries[0]!.stderrBytes)).toBeGreaterThan(0);
    expect(log.text()).not.toContain(marker);
  });

  it('passes on the engine\'s class name and frames when stderr is exactly the wrapper\'s structured line, and nothing else', async () => {
    const good = recordingLogger();
    await reader({ command: sh(`echo '{"readerError":"Invalid","frames":["main:49","process_source:280"]}' >&2; exit 2`), logger: good.logger }).read('x');
    expect(good.entries[0]).toMatchObject({ readerError: 'Invalid', frames: ['main:49', 'process_source:280'] });

    const bad = recordingLogger();
    await reader({ command: sh(`echo '{"readerError":"Invalid\\nCYP2C19 text","frames":["main:49"]}' >&2; exit 2`), logger: bad.logger }).read('x');
    expect(bad.entries[0]).not.toHaveProperty('readerError');
    expect(bad.text()).not.toContain('CYP2C19 text');

    const injected = recordingLogger();
    await reader({ command: sh(`echo '{"readerError":"Invalid","frames":["main:49","CYP2C19: diplotype *1/*2"]}' >&2; exit 2`), logger: injected.logger }).read('x');
    expect(injected.entries[0]).toMatchObject({ readerError: 'Invalid' });
    expect(injected.entries[0]).not.toHaveProperty('frames');
    expect(injected.text()).not.toContain('diplotype');
  });

  it('does not pass the caller\'s environment to the subprocess', async () => {
    process.env.REPORT_READER_TEST_SECRET = 'must-not-leak';
    try {
      const dir = mkdtempSync(join(tmpdir(), 'reader-'));
      const out = join(dir, 'env.txt');
      await reader({ command: sh(`env > ${out}; echo '{}'`) }).read('x');
      const env = readFileSync(out, 'utf8');
      expect(env).not.toContain('must-not-leak');
      expect(env).toContain('PYTHONDONTWRITEBYTECODE=1');
    } finally {
      delete process.env.REPORT_READER_TEST_SECRET;
    }
  });
});
