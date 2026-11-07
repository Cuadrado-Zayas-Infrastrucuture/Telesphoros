import { describe, expect, it, vi } from 'vitest';
import { sweepCapabilities } from './job-data';
import type { LogFields, Logger } from './log';
import { Ticker } from './scheduler';

type Line = [level: string, event: string, fields: LogFields | undefined];
const capture = (): { lines: Line[]; log: Logger } => {
  const lines: Line[] = [];
  return { lines, log: (level, event, fields) => void lines.push([level, event, fields]) };
};

describe('Ticker', () => {
  it('coalesces timer ticks while a run is stalled and stops without draining a backlog', async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let runs = 0;
    const ticker = new Ticker(
      'schedule',
      async () => {
        runs++;
        await held;
        return 0;
      },
      1,
      capture().log,
    );
    try {
      ticker.start();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(runs).toBe(1);
      const stopped = ticker.stop();
      finish();
      await stopped;
      expect(runs).toBe(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(runs).toBe(1);
      await ticker.tick();
      expect(runs).toBe(2);
    } finally {
      finish();
      await ticker.stop();
      vi.useRealTimers();
    }
  });

  it('by default logs a run only when it did something, with its count (the tick and the relay, unchanged)', async () => {
    const { lines, log } = capture();
    await new Ticker('schedule', async () => 0, 60, log).tick();
    await new Ticker('schedule', async () => 2, 60, log).tick();
    expect(lines).toEqual([['info', 'schedule-ran', { count: 2 }]]);
  });

  it('with logEveryRun, logs every run, one that removed nothing included, with its outcome (spec 026: the stale alarm counts these lines)', async () => {
    const { lines, log } = capture();
    const reports = [
      { count: 0, outcome: 'current' },
      { count: 1000, outcome: 'behind' },
    ];
    let i = 0;
    const sweep = new Ticker('capability-sweep', async () => reports[i++]!, 60, log, { logEveryRun: true });
    await sweep.tick();
    await sweep.tick();
    expect(lines).toEqual([
      ['info', 'capability-sweep-ran', { count: 0, outcome: 'current' }],
      ['info', 'capability-sweep-ran', { count: 1000, outcome: 'behind' }],
    ]);
  });

  it('a failed run logs a code, never the error, and the next run still happens', async () => {
    const { lines, log } = capture();
    let n = 0;
    const sweep = new Ticker(
      'capability-sweep',
      async () => {
        n++;
        if (n === 1) throw new Error('connect ECONNREFUSED 10.0.0.5:5432');
        return { count: 3, outcome: 'current' };
      },
      60,
      log,
      { logEveryRun: true },
    );
    await sweep.tick();
    await sweep.tick();
    expect(lines).toEqual([
      ['error', 'capability-sweep-failed', { code: 'queue-unavailable' }],
      ['info', 'capability-sweep-ran', { count: 3, outcome: 'current' }],
    ]);
    expect(JSON.stringify(lines)).not.toMatch(/ECONNREFUSED|10\.0\.0\.5/);
  });
});

describe('sweepCapabilities', () => {
  it('calls the database function with the batch and reports the count and whether a full batch was removed', async () => {
    const calls: Array<[string, unknown[] | undefined]> = [];
    const db = (row: object) => ({
      query: async (sql: string, params?: unknown[]) => {
        calls.push([sql, params]);
        return { rows: [row], rowCount: 1 };
      },
    });
    expect(await sweepCapabilities(db({ removed: 1000, behind: true }) as never, 1000)).toEqual({ count: 1000, outcome: 'behind' });
    expect(await sweepCapabilities(db({ removed: 4, behind: false }) as never, 1000)).toEqual({ count: 4, outcome: 'current' });
    expect(calls).toEqual([
      ['SELECT removed, behind FROM capabilities_sweep_run($1)', [1000]],
      ['SELECT removed, behind FROM capabilities_sweep_run($1)', [1000]],
    ]);
  });
});
