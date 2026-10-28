import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineJob, fatal, retryable, type ClaimedJob, type JobQueue } from '@telesphoros/jobs';
import { claimBackoffMs, Runner, type Handler } from './runner';
import { silentLogger } from './log';

const def = (type: string, extra: Partial<Parameters<typeof defineJob>[0]> = {}) =>
  defineJob({ type, payload: z.strictObject({}), maxAttempts: 3, leaseSeconds: 5, timeoutSeconds: 30, ...extra });

class FakeQueue {
  pending: ClaimedJob[] = [];
  succeeded: string[] = [];
  failed: { id: string; code: string; retryable: boolean }[] = [];
  released: string[] = [];
  claims = 0;
  claimError = false;
  async claim(): Promise<ClaimedJob[]> {
    this.claims += 1;
    if (this.claimError) throw new Error('db down');
    return this.pending.splice(0, 10);
  }
  async heartbeat() {
    return true;
  }
  async succeed(id: string) {
    this.succeeded.push(id);
    return true;
  }
  async fail(id: string, _w: string, code: string, canRetry: boolean) {
    this.failed.push({ id, code, retryable: canRetry });
    return canRetry ? ('retry' as const) : ('dead' as const);
  }
  async release(id: string) {
    this.released.push(id);
    return true;
  }
  async workerSeen() {}
}
const job = (id: string, type: string, payload: Record<string, unknown> = {}): ClaimedJob => ({
  id,
  tenantId: 't',
  type,
  payload,
  attempt: 1,
  maxAttempts: 3,
  leaseUntil: new Date(),
  requestedBy: 'u',
});
const make = (queue: FakeQueue, handlers: Record<string, { handler: Handler; extra?: Partial<Parameters<typeof defineJob>[0]> }>, drainSeconds = 1) =>
  new Runner({
    workerId: 'w',
    queue: queue as unknown as JobQueue,
    jobs: Object.entries(handlers).map(([type, h]) => ({ definition: def(type, h.extra), handler: h.handler })),
    concurrency: 3,
    tenantCap: 2,
    pollMs: 20,
    drainSeconds,
    log: silentLogger,
  });
const until = async (check: () => boolean) => {
  for (let i = 0; i < 400 && !check(); i += 1) await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
};
let runner: Runner | undefined;
afterEach(async () => {
  await runner?.stop();
  runner = undefined;
});

describe('Runner', () => {
  it('needs at least one job type', () => {
    expect(() => make(new FakeQueue(), {})).toThrow(/at least one job type/);
  });

  it('runs a handler as the system actor named after the job type and reports success', async () => {
    const q = new FakeQueue();
    const seen: string[] = [];
    runner = make(q, { 'test.a': { handler: async ({ actor }) => void seen.push(actor) } });
    q.pending.push(job('1', 'test.a'));
    runner.start();
    await until(() => q.succeeded.length === 1);
    expect(seen).toEqual(['system:test.a']);
  });

  it('reports a retryable error, a fatal error and a surprise by code', async () => {
    const q = new FakeQueue();
    runner = make(q, {
      'test.r': { handler: async () => Promise.reject(retryable('upstream-timeout')) },
      'test.f': { handler: async () => Promise.reject(fatal('bad-input')) },
      'test.s': { handler: async () => Promise.reject(new Error('Jane Doe CYP2D6')) },
    });
    q.pending.push(job('1', 'test.r'), job('2', 'test.f'), job('3', 'test.s'));
    runner.start();
    await until(() => q.failed.length === 3);
    expect(q.failed.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: '1', code: 'upstream-timeout', retryable: true },
      { id: '2', code: 'bad-input', retryable: false },
      { id: '3', code: 'handler-error', retryable: true },
    ]);
  });

  it('fails a job of an unknown type or with an invalid payload as fatal, without running a handler', async () => {
    const q = new FakeQueue();
    const handler = vi.fn(async () => undefined);
    runner = make(q, { 'test.a': { handler } });
    q.pending.push(job('1', 'test.unknown'), job('2', 'test.a', { extra: 1 }));
    runner.start();
    await until(() => q.failed.length === 2);
    expect(q.failed.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: '1', code: 'unknown-job-type', retryable: false },
      { id: '2', code: 'invalid-payload', retryable: false },
    ]);
    expect(handler).not.toHaveBeenCalled();
  });

  it('abandons a handler that never returns once its timeout passes', async () => {
    const q = new FakeQueue();
    runner = make(q, { 'test.h': { handler: () => new Promise<void>(() => undefined), extra: { timeoutSeconds: 1 } } });
    q.pending.push(job('1', 'test.h'));
    runner.start();
    await until(() => q.failed.length === 1);
    expect(q.failed[0]).toEqual({ id: '1', code: 'handler-timeout', retryable: true });
  });

  it('keeps going when the queue is unavailable, and claims again when it returns', async () => {
    const q = new FakeQueue();
    q.claimError = true;
    runner = make(q, { 'test.a': { handler: async () => undefined } });
    q.pending.push(job('1', 'test.a'));
    runner.start();
    await until(() => q.claims >= 2);
    expect(q.succeeded).toEqual([]);
    q.claimError = false;
    await until(() => q.succeeded.length === 1);
  });

  it('stops claiming on stop, waits for running jobs within the drain, and releases the rest', async () => {
    const q = new FakeQueue();
    let finish: () => void = () => undefined;
    runner = make(
      q,
      {
        'test.quick': { handler: () => new Promise<void>((resolve) => (finish = resolve)) },
        'test.stuck': { handler: ({ signal }) => new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) },
      },
      0.2,
    );
    q.pending.push(job('1', 'test.stuck'));
    runner.start();
    await until(() => runner!.activeCount === 1);
    const claimsBefore = q.claims;
    await runner.stop();
    expect(q.released).toEqual(['1']);
    expect(q.failed).toEqual([]); // a released job's late result is dropped
    expect(q.succeeded).toEqual([]);
    await new Promise((r) => setTimeout(r, 100));
    expect(q.claims).toBeLessThanOrEqual(claimsBefore + 1);
    finish();
  });
});

describe('the pause after a failed claim (audit item 28: workers recovering from one outage all came back in step)', () => {
  it('doubles from twice the poll interval, with up to 20% either way, and never passes 30 seconds', () => {
    expect([1, 2, 3].map((f) => claimBackoffMs(f, 1000, 0.5))).toEqual([2000, 4000, 8000]); // no jitter at the middle of the range
    expect([1, 2, 3].map((f) => claimBackoffMs(f, 1000, 0))).toEqual([1600, 3200, 6400]);
    expect([1, 2, 3].map((f) => claimBackoffMs(f, 1000, 1))).toEqual([2400, 4800, 9600]);
    for (const random of [0, 0.5, 1]) expect(claimBackoffMs(50, 1000, random)).toBeLessThanOrEqual(30_000);
  });

  it('is used by the claim loop: each failure waits a randomised time, not the same one for every worker', async () => {
    const delays: number[] = [];
    const real = globalThis.setTimeout;
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      if (typeof ms === 'number' && [32, 64, 128].includes(ms)) delays.push(ms);
      return real(fn, Math.min(ms ?? 0, 5));
    }) as typeof setTimeout);
    const q = new FakeQueue();
    q.claimError = true;
    runner = make(q, { 'test.a': { handler: async () => undefined } });
    runner.start();
    await until(() => delays.length >= 3);
    vi.restoreAllMocks();
    expect(delays.slice(0, 3)).toEqual([32, 64, 128]); // pollMs is 20: base 40, 80, 160, each at 80% (random 0)
  });
});

describe('a job reclaimed by the worker that already runs it (audit W2)', () => {
  class HolderQueue extends FakeQueue {
    claimedAs: string[] = [];
    succeededAs: string[] = [];
    heartbeatAs: string[] = [];
    override async claim(...args: unknown[]): Promise<ClaimedJob[]> {
      this.claimedAs.push(args[0] as string);
      return super.claim();
    }
    override async heartbeat(...args: unknown[]) {
      this.heartbeatAs.push(args[1] as string);
      return true;
    }
    override async succeed(id: string, ...rest: unknown[]) {
      this.succeededAs.push(rest[0] as string);
      return super.succeed(id);
    }
  }

  it('claims as a holder unique to each claim, and runs, heartbeats and settles the job as that holder', async () => {
    const q = new HolderQueue();
    const seen: string[] = [];
    runner = make(q, { 'test.a': { handler: async ({ workerId }) => void seen.push(workerId) } });
    q.pending.push(job('1', 'test.a'));
    runner.start();
    await until(() => q.succeeded.length === 1 && q.claimedAs.length >= 2);
    expect(q.claimedAs[0]).toMatch(/^w#[0-9a-f]{8}$/);
    expect(new Set(q.claimedAs).size).toBe(q.claimedAs.length);
    expect(seen).toEqual([q.claimedAs[0]]);
    expect(q.succeededAs).toEqual([q.claimedAs[0]]);
  });

  it('stops the old attempt when the same job is claimed again, and keeps the new one in its running set', async () => {
    const q = new HolderQueue();
    const signals: AbortSignal[] = [];
    let finishSecond!: () => void;
    runner = make(q, {
      'test.a': {
        handler: ({ signal }) => {
          signals.push(signal);
          if (signals.length === 1) return new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
          return new Promise<void>((resolve) => (finishSecond = resolve));
        },
      },
    });
    q.pending.push(job('1', 'test.a'));
    runner.start();
    await until(() => signals.length === 1);
    q.pending.push(job('1', 'test.a')); // its lease ran out and this worker claimed it again
    await until(() => signals.length === 2);
    await until(() => signals[0]!.aborted);
    await until(() => q.failed.length === 1); // the old attempt settled (the database refuses it: another holder)
    expect(signals[1]!.aborted).toBe(false);
    expect(runner.activeCount).toBe(1); // the old attempt's cleanup did not remove the new one
    finishSecond();
    await until(() => q.succeeded.length === 1 && runner!.activeCount === 0);
  });
});
