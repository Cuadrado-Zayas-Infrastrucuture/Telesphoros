import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LogFields } from './log';
import { boundedStop, shutdownDeadlineMs, type StopStep } from './shutdown';

// The shared bounded stop. The file worker's own sequence on top of it is tested in apps/worker/src/shutdown.test.ts.
const NEVER = () => new Promise<void>(() => undefined);

function harness(steps?: StopStep[]) {
  const calls: string[] = [];
  const lines: Array<{ level: string; event: string; fields?: LogFields }> = [];
  const exits: number[] = [];
  const stop = boundedStop({
    steps: steps ?? ['runner', 'pool', 'app'].map((name) => ({ name, run: async () => void calls.push(name) })),
    log: (level, event, fields) => void lines.push({ level, event, fields }),
    exit: (code) => void exits.push(code),
    deadlineMs: 45_000,
  });
  return { stop, calls, lines, exits };
}

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

describe('the bounded stop', () => {
  it('runs the steps in order and exits 0, and the deadline does not fire afterwards', async () => {
    const h = harness();
    await h.stop('SIGTERM');
    expect(h.calls).toEqual(['runner', 'pool', 'app']);
    expect(h.exits).toEqual([0]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.exits).toEqual([0]);
    expect(h.lines.map((l) => l.event)).toEqual(['shutdown-requested']);
  });

  it('a second signal does nothing', async () => {
    const h = harness();
    await h.stop('SIGTERM');
    await h.stop('SIGINT');
    expect(h.calls).toEqual(['runner', 'pool', 'app']);
    expect(h.exits).toEqual([0]);
  });

  it('exits 1 at the deadline, with a named log line, when a step never finishes', async () => {
    const h = harness([{ name: 'pool', run: NEVER }]);
    void h.stop('SIGTERM');
    await vi.advanceTimersByTimeAsync(44_999);
    expect(h.exits).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.exits).toEqual([1]);
    expect(h.lines.at(-1)).toMatchObject({ level: 'error', event: 'shutdown-forced', fields: { reason: 'deadline', count: 45 } });
  });

  it('a step that throws does not stop the later steps; the exit code is 1 and the log carries its name, not the error', async () => {
    const calls: string[] = [];
    const h = harness([
      {
        name: 'runner',
        run: async () => {
          throw new Error('connect ECONNREFUSED 10.1.2.3:5432 password=secret');
        },
      },
      { name: 'app', run: async () => void calls.push('app') },
    ]);
    await h.stop('SIGTERM');
    expect(calls).toEqual(['app']);
    expect(h.exits).toEqual([1]);
    expect(h.lines.find((l) => l.event === 'shutdown-step-failed')?.fields).toEqual({ code: 'runner' });
    expect(JSON.stringify(h.lines)).not.toMatch(/ECONNREFUSED|10\.1\.2\.3|secret/);
  });

  it('the deadline is the drain plus a fixed grace', () => {
    expect(shutdownDeadlineMs(30)).toBe(45_000);
    expect(shutdownDeadlineMs(0)).toBe(15_000);
  });
});
