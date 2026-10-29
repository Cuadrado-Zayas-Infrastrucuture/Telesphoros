import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PINNED_READER } from './pinned-reader';
import { type ReaderLogger, ReaderNotApprovedError } from './report-reader';
import { SubprocessReportReader } from './subprocess-report-reader';

// The wrapper around the report-reader subprocess, driven with stand-in commands: deadlines, the process-group kill, the output cap, malformed output,
// the refusals made before anything is spawned, and what is logged. Nothing here runs the engine, so this file runs in every checkout and in CI
// (spec 004 slice 4 split it out of subprocess-report-reader.spec.ts, which keeps the tests of the real engine).

function recordingLogger() {
  const entries: Array<Record<string, unknown>> = [];
  const logger: ReaderLogger = { warn: (fields) => void entries.push(fields) };
  return { logger, entries, text: () => JSON.stringify(entries) };
}

const reader = (extra: Partial<ConstructorParameters<typeof SubprocessReportReader>[0]> = {}) => new SubprocessReportReader({ mode: 'non-production', ...extra });
const sh = (script: string) => ['sh', '-c', script];

describe('the pinned reader', () => {
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
});

describe('a misbehaving subprocess becomes a hold, never a hang, a crash, or a leak', () => {
  // Pid files of processes a test started outside the reader's process group. afterEach runs even when a test times out.
  const escapedPidFiles: string[] = [];
  afterEach(() => {
    for (const file of escapedPidFiles.splice(0)) {
      if (!existsSync(file)) continue;
      try {
        process.kill(Number(readFileSync(file, 'utf8').trim()), 'SIGKILL'); // only the process this test started, by the pid it recorded
      } catch {
        // intentional: already gone
      }
    }
  });

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
    const alive = () => {
      try {
        process.kill(grandchild, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 40 && alive(); i += 1) await new Promise((r2) => setTimeout(r2, 50));
    expect(alive()).toBe(false);
  }, 15_000);

  it('settles once the process has exited even if a descendant that left its group holds stdout open, and discards the output (audit O2)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reader-'));
    const pidFile = join(dir, 'escaped.pid');
    escapedPidFiles.push(pidFile);
    // The child forks a grandchild that moves to its own session (out of reach of the group kill) and keeps stdout; the child prints and exits 0.
    const script = [
      'import os, sys, time',
      'if os.fork() == 0:',
      '    os.setsid()',
      `    open(${JSON.stringify(pidFile)}, 'w').write(str(os.getpid()))`,
      '    time.sleep(60)',
      '    os._exit(0)',
      `while not os.path.exists(${JSON.stringify(pidFile)}): time.sleep(0.01)`,
      "sys.stdout.write('{}')",
    ].join('\n');
    const { logger, entries } = recordingLogger();
    const r = reader({ command: ['python3', '-c', script], deadlineMs: 30_000, killGraceMs: 300, logger });
    const started = Date.now();
    const result = await r.read('x');
    expect(Date.now() - started).toBeLessThan(5_000); // well inside the 30 s deadline: settled by the exit, not by the deadline
    expect(result.projection).toMatchObject({ status: 'held', reason: 'worker-error' });
    expect(entries).toEqual([expect.objectContaining({ event: 'report-reader-failure', cause: 'output-held-open', exitCode: 0 })]);
  }, 15_000);

  it('keeps waiting while output still drains after the exit, so a slow pipe is not mistaken for one held open (control for O2)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reader-'));
    const pidFile = join(dir, 'escaped.pid');
    escapedPidFiles.push(pidFile);
    // As above, but the escaped grandchild writes every 100 ms for about a second and then exits, closing the pipe: never silent for the grace.
    const script = [
      'import os, sys, time',
      'if os.fork() == 0:',
      '    os.setsid()',
      `    open(${JSON.stringify(pidFile)}, 'w').write(str(os.getpid()))`,
      '    for _ in range(10):',
      "        sys.stdout.write('.'); sys.stdout.flush(); time.sleep(0.1)",
      '    os._exit(0)',
      `while not os.path.exists(${JSON.stringify(pidFile)}): time.sleep(0.01)`,
    ].join('\n');
    const { logger, entries } = recordingLogger();
    const r = reader({ command: ['python3', '-c', script], deadlineMs: 30_000, killGraceMs: 300, logger });
    const started = Date.now();
    const result = await r.read('x');
    expect(Date.now() - started).toBeGreaterThanOrEqual(900); // it waited for the pipe to close, well past one 300 ms grace after the exit
    expect(result.projection).toMatchObject({ status: 'held', reason: 'worker-error' });
    expect(entries).toEqual([expect.objectContaining({ event: 'report-reader-failure', cause: 'output-not-json' })]);
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

  it("passes on the engine's class name and frames when stderr is exactly the wrapper's structured line, and nothing else", async () => {
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

  it("does not pass the caller's environment to the subprocess", async () => {
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
