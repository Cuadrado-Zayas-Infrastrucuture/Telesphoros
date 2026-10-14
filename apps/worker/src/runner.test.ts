import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { defineJob, fatal, retryable, type ClaimedJob, type JobQueue } from '@telesphoros/jobs';
import { Runner, type Handler } from './runner';
import { silentLogger } from './log';

const def = (type: string, extra: Partial<Parameters<typeof defineJob>[0]> = {}) => defineJob({ type, payload: z.strictObject({}), maxAttempts: 3, leaseSeconds: 5, timeoutSeconds: 30, ...extra });

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
const job = (id: string, type: string, payload: Record<string, unknown> = {}): ClaimedJob => ({ id, tenantId: 't', type, payload, attempt: 1, maxAttempts: 3, leaseUntil: new Date(), requestedBy: 'u' });
const make = (queue: FakeQueue, handlers: Record<string, { handler: Handler; extra?: Partial<Parameters<typeof defineJob>[0]> }>, drainSeconds = 1) =>
  new Runner({ workerId: 'w', queue: queue as unknown as JobQueue, jobs: Object.entries(handlers).map(([type, h]) => ({ definition: def(type, h.extra), handler: h.handler })), concurrency: 3, tenantCap: 2, pollMs: 20, drainSeconds, log: silentLogger });
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
    expect(q.failed.sort((a, b) => a.id.localeCompare(b.id))).toEqual([{ id: '1', code: 'unknown-job-type', retryable: false }, { id: '2', code: 'invalid-payload', retryable: false }]);
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
    runner = make(q, {
      'test.quick': { handler: () => new Promise<void>((resolve) => (finish = resolve)) },
      'test.stuck': { handler: ({ signal }) => new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) },
    }, 0.2);
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
