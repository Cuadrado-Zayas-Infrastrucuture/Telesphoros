import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LogFields } from './log';
import { createShutdown, shutdownDeadlineMs, type ShutdownParts } from './shutdown';

const NEVER = () => new Promise<void>(() => undefined);

function harness(overrides: Partial<ShutdownParts> = {}) {
  const calls: string[] = [];
  const lines: Array<{ level: string; event: string; fields?: LogFields }> = [];
  const exits: number[] = [];
  const parts: ShutdownParts = {
    closeHealth: () => void calls.push('health'),
    tickers: [{ stop: async () => void calls.push('ticker-1') }, { stop: async () => void calls.push('ticker-2') }],
    runner: { stop: async () => void calls.push('runner') },
    closePool: async () => void calls.push('pool'),
    log: (level, event, fields) => void lines.push({ level, event, fields }),
    exit: (code) => void exits.push(code),
    deadlineMs: 45_000,
    ...overrides,
  };
  return { parts, calls, lines, exits, run: () => createShutdown(parts) };
}

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

describe('the worker stop sequence', () => {
  it('stops everything in order and exits 0, and does not fire the deadline afterwards', async () => {
    const h = harness();
    await h.run()('SIGTERM');
    expect(h.calls).toEqual(['health', 'ticker-1', 'ticker-2', 'runner', 'pool']);
    expect(h.exits).toEqual([0]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.exits).toEqual([0]); // the timer was cleared: no second exit, no forced line
    expect(h.lines.map((l) => l.event)).toEqual(['shutdown-requested']);
  });

  it('a second signal does nothing', async () => {
    const h = harness();
    const shutdown = h.run();
    await shutdown('SIGTERM');
    await shutdown('SIGINT');
    expect(h.calls.filter((c) => c === 'runner')).toHaveLength(1);
    expect(h.exits).toEqual([0]);
  });

  it.each([
    ['a ticker whose last query never returns', { tickers: [{ stop: NEVER }] }],
    ['a runner that never finishes draining', { runner: { stop: NEVER } }],
    ['a pool that never closes', { closePool: NEVER }],
  ] as const)('exits 1 at the deadline, with a named log line, when there is %s', async (_name, override) => {
    const h = harness(override as Partial<ShutdownParts>);
    void h.run()('SIGTERM');
    await vi.advanceTimersByTimeAsync(44_999);
    expect(h.exits).toEqual([]); // not before the deadline
    await vi.advanceTimersByTimeAsync(1);
    expect(h.exits).toEqual([1]);
    expect(h.lines.at(-1)).toMatchObject({ level: 'error', event: 'shutdown-forced', fields: { reason: 'deadline', count: 45 } });
  });

  it('a step that throws does not stop the later steps; the exit code is 1 and the log carries a code, not the error', async () => {
    const h = harness({
      tickers: [
        {
          stop: async () => {
            throw new Error('connect ECONNREFUSED 10.1.2.3:5432 password=secret');
          },
        },
      ],
    });
    await h.run()('SIGTERM');
    expect(h.calls).toEqual(['health', 'runner', 'pool']);
    expect(h.exits).toEqual([1]);
    const failed = h.lines.find((l) => l.event === 'shutdown-step-failed');
    expect(failed?.fields).toEqual({ code: 'tickers' });
    expect(JSON.stringify(h.lines)).not.toMatch(/ECONNREFUSED|10\.1\.2\.3|secret/);
  });

  it('the deadline is the drain plus a fixed grace, and the container is given longer than that', () => {
    expect(shutdownDeadlineMs(30)).toBe(45_000);
    expect(shutdownDeadlineMs(0)).toBe(15_000);
  });
});
