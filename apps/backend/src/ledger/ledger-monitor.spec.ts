import { Logger } from '@nestjs/common';
import { AppException } from '../common/app-exception';
import { LedgerMonitor, type LedgerWatchConfig, type VerifierPort } from './ledger-monitor';
import { LedgerStatus } from './ledger-status';
import type { VerifyOptions, VerifyResult } from './verifier';

// The ledger watch's decisions, with a fake verifier so every outcome (damage, running out of time, a failing login, two callers at once)
// can be produced on demand. The real verifier against real tampering is test/db/ledger-watch.pg-spec.ts. Synthetic data only.

const config = (over: Partial<LedgerWatchConfig> = {}): LedgerWatchConfig => ({
  production: false, startupBudgetMs: 20_000, fullIntervalMs: 0, fullBudgetMs: 900_000, onDemandBudgetMs: 30_000, fullWalkAtOrBelowEvents: 50_000, ...over,
});

const outcome = (tenantId: string, over: Partial<VerifyResult> = {}): VerifyResult => ({
  tenantId, status: 'ok', mode: 'tail', headSeq: '5', headHash: 'a'.repeat(64), eventsChecked: 5, failures: [], checkpointId: null, ...over,
});
const failed = (tenantId: string): VerifyResult => outcome(tenantId, { status: 'failed', failures: [{ kind: 'payload-mismatch', seq: '9' }, { kind: 'head-mismatch', seq: '12' }] });

type Answer = (tenantId: string, options: VerifyOptions) => Promise<VerifyResult> | VerifyResult;

class FakeVerifier implements VerifierPort {
  calls: Array<{ tenantId: string; options: VerifyOptions }> = [];
  closed = false;
  active = 0;
  maxActive = 0;
  failTenants: Error | null = null;
  constructor(public tenantIds: string[], public answer: Answer = (tenantId, options) => outcome(tenantId, { mode: options.mode ?? 'tail' })) {}
  async tenants(): Promise<string[]> {
    if (this.failTenants) throw this.failTenants;
    return this.tenantIds;
  }
  async verify(tenantId: string, options: VerifyOptions = {}): Promise<VerifyResult> {
    this.calls.push({ tenantId, options });
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      return await this.answer(tenantId, options);
    } finally {
      this.active -= 1;
    }
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  get tail() { return this.calls.filter((c) => c.options.mode === 'tail'); }
  get full() { return this.calls.filter((c) => c.options.mode === 'full'); }
}

/** A promise a test settles by hand. */
function gate<T = void>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { release = resolve; });
  return { promise, release };
}

let errors: jest.SpyInstance;
let warnings: jest.SpyInstance;
beforeEach(() => {
  errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  warnings = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

function build(verifier: FakeVerifier | undefined, cfg: Partial<LedgerWatchConfig> = {}) {
  const status = new LedgerStatus();
  const monitor = new LedgerMonitor(config(cfg), verifier, status);
  return { monitor, status };
}
async function started(verifier: FakeVerifier, cfg: Partial<LedgerWatchConfig> = {}) {
  const made = build(verifier, cfg);
  await made.monitor.onApplicationBootstrap();
  await made.monitor.idle();
  return made;
}

describe('LedgerMonitor: with no verifier login', () => {
  it('does nothing at all: not enabled, no state change, writes stay open', async () => {
    const { monitor, status } = build(undefined);
    expect(monitor.enabled).toBe(false);
    await monitor.onApplicationBootstrap();
    await monitor.idle();
    expect(status.tailState).toBe('not-run');
    expect(() => status.assertOpen()).not.toThrow();
    await monitor.onModuleDestroy();
  });

  it('refuses an admin check as an installation fault', async () => {
    await expect(build(undefined).monitor.verifyNow('t', false)).rejects.toMatchObject({ status: 500, code: 'PIPELINE_MISCONFIGURED' });
  });
});

describe('LedgerMonitor: the check at start', () => {
  it('walks each tenant from its checkpoint, passes the budget and the full-walk threshold on, and then reports ready (verifying, then up)', async () => {
    const verifier = new FakeVerifier(['a', 'b']);
    const { monitor, status } = build(verifier);
    await monitor.onApplicationBootstrap();
    expect(verifier.tail.map((c) => c.tenantId)).toEqual(['a', 'b']);
    expect(verifier.tail[0]!.options).toMatchObject({ mode: 'tail', fullWalkAtOrBelow: 50_000 });
    expect(verifier.tail[0]!.options.budgetMs).toBeLessThanOrEqual(20_000);
    expect(verifier.tail[0]!.options.recordCheckpoint).toBeUndefined(); // the start check writes nothing
    expect(status.tailState).toBe('ok');
    await monitor.idle();
    expect(status.readiness()).toBe('up');
    await monitor.onModuleDestroy();
  });

  it('shares ONE budget across tenants and does not start a tenant after it is spent (incomplete, never ok)', async () => {
    let clock = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    const verifier = new FakeVerifier(['a', 'b', 'c', 'd'], (tenantId, options) => {
      clock += 8_000;
      return outcome(tenantId, { mode: options.mode ?? 'tail' });
    });
    const { monitor, status } = build(verifier);
    await monitor.onApplicationBootstrap();
    expect(verifier.tail.map((c) => [c.tenantId, c.options.budgetMs])).toEqual([['a', 20_000], ['b', 12_000], ['c', 4_000]]);
    expect(status.tailState).toBe('incomplete');
    expect(status.readiness()).toBe('down');
    await monitor.onModuleDestroy();
  });

  it('control: the same chain inside the budget is ok', async () => {
    let clock = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    const verifier = new FakeVerifier(['a', 'b', 'c'], (tenantId) => {
      clock += 6_000;
      return outcome(tenantId);
    });
    const { monitor, status } = build(verifier);
    await monitor.onApplicationBootstrap();
    expect(status.tailState).toBe('ok');
    await monitor.onModuleDestroy();
  });

  describe('in production', () => {
    it('refuses to start when a tenant fails, says which kind and where, and names no tenant', async () => {
      const verifier = new FakeVerifier(['tenant-secret-name'], (tenantId) => failed(tenantId));
      const { monitor, status } = build(verifier, { production: true });
      const error = await monitor.onApplicationBootstrap().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/failed.*payload-mismatch at sequence 9/);
      expect((error as Error).message).not.toContain('tenant-secret-name');
      expect(status.tailState).toBe('failed');
      expect(status.compromised).toMatchObject({ kind: 'payload-mismatch', seq: '9', source: 'startup' });
      expect(verifier.full).toEqual([]); // nothing runs in the background after a refused start
    });

    it('refuses to start when the check runs out of time', async () => {
      const verifier = new FakeVerifier(['a'], (tenantId) => outcome(tenantId, { status: 'incomplete' }));
      await expect(build(verifier, { production: true }).monitor.onApplicationBootstrap()).rejects.toThrow(/incomplete/);
    });

    it('refuses to start when the check cannot run at all (login or network): nothing is known, which is not "fine"', async () => {
      const verifier = new FakeVerifier(['a']);
      verifier.failTenants = Object.assign(new Error('password authentication failed for user ledger_verifier_login'), { code: '28P01' });
      const { monitor } = build(verifier, { production: true });
      await expect(monitor.onApplicationBootstrap()).rejects.toThrow(/incomplete/);
      // The log names the class and the database code, never the driver's message (host and user names).
      expect(JSON.stringify(errors.mock.calls)).toContain('Error 28P01');
      expect(JSON.stringify(errors.mock.calls)).not.toMatch(/password|ledger_verifier_login/);
    });

    it('control: a clean check starts', async () => {
      await expect(build(new FakeVerifier(['a']), { production: true }).monitor.onApplicationBootstrap()).resolves.toBeUndefined();
    });
  });

  describe('outside production', () => {
    it('warns and carries on after a failure, but latches it (writes stop, readiness fails), and still runs the background walk', async () => {
      const verifier = new FakeVerifier(['a'], (tenantId, options) => (options.mode === 'tail' ? failed(tenantId) : outcome(tenantId, { mode: 'full' })));
      const { monitor, status } = build(verifier);
      await expect(monitor.onApplicationBootstrap()).resolves.toBeUndefined();
      await monitor.idle();
      expect(status.tailState).toBe('failed');
      expect(status.compromised).toMatchObject({ kind: 'payload-mismatch', seq: '9' });
      expect(status.readiness()).toBe('down');
      expect(() => status.assertOpen()).toThrow();
      expect(warnings.mock.calls.flat().some((c) => c?.event === 'ledger-startup-check' && c.outcome === 'failed')).toBe(true);
      expect(verifier.full).toHaveLength(1);
      await monitor.onModuleDestroy();
    });

    it('warns and carries on when the check could not run; readiness stays down (the log is unverified), writes are not stopped', async () => {
      const verifier = new FakeVerifier(['a']);
      verifier.failTenants = new Error('connection refused');
      const { monitor, status } = build(verifier);
      await expect(monitor.onApplicationBootstrap()).resolves.toBeUndefined();
      await monitor.idle();
      expect(status.tailState).toBe('incomplete');
      expect(status.readiness()).toBe('down');
      expect(status.compromised).toBeNull();
      await monitor.onModuleDestroy();
    });
  });
});

describe('LedgerMonitor: the background full walk', () => {
  it('walks every tenant in full, records a checkpoint on each, and then reports up', async () => {
    const verifier = new FakeVerifier(['a', 'b']);
    const { monitor, status } = await started(verifier);
    expect(verifier.full.map((c) => c.tenantId)).toEqual(['a', 'b']);
    for (const call of verifier.full) expect(call.options).toMatchObject({ mode: 'full', recordCheckpoint: true, budgetMs: 900_000 });
    expect(status.readiness()).toBe('up');
    await monitor.onModuleDestroy();
  });

  it('stays "verifying" while it runs, and is ready throughout', async () => {
    const hold = gate<VerifyResult>();
    const verifier = new FakeVerifier(['a'], (tenantId, options) => (options.mode === 'full' ? hold.promise : outcome(tenantId)));
    const { monitor, status } = build(verifier);
    await monitor.onApplicationBootstrap();
    expect(status.readiness()).toBe('verifying');
    hold.release(outcome('a', { mode: 'full' }));
    await monitor.idle();
    expect(status.readiness()).toBe('up');
    await monitor.onModuleDestroy();
  });

  it('LATCHES on a failed walk: logs the kind and sequence only, stops checkpoints for the tenants after it, and readiness fails', async () => {
    const verifier = new FakeVerifier(['a', 'b'], (tenantId, options) => (options.mode === 'full' && tenantId === 'a'
      ? { ...failed(tenantId), failures: [{ kind: 'payload-mismatch', seq: '9', value: 'SECRET-NOTE-TEXT' } as never] }
      : outcome(tenantId, { mode: options.mode ?? 'tail' })));
    const { monitor, status } = await started(verifier);
    expect(status.compromised).toMatchObject({ tenantId: 'a', kind: 'payload-mismatch', seq: '9', source: 'background' });
    expect(status.readiness()).toBe('down');
    expect(verifier.full.map((c) => [c.tenantId, c.options.recordCheckpoint])).toEqual([['a', true], ['b', false]]);
    const logged = errors.mock.calls.flat().find((c) => c?.event === 'ledger-compromised');
    expect(logged).toMatchObject({ event: 'ledger-compromised', tenantId: 'a', source: 'background', failures: [{ kind: 'payload-mismatch', seq: '9' }] });
    expect(JSON.stringify(errors.mock.calls)).not.toContain('SECRET-NOTE-TEXT');
    await monitor.onModuleDestroy();
  });

  it('does not report up when a tenant is too large for its budget: it stays "verifying", is logged, and nothing is latched', async () => {
    const verifier = new FakeVerifier(['a'], (tenantId, options) => (options.mode === 'full' ? outcome(tenantId, { status: 'incomplete', mode: 'full' }) : outcome(tenantId)));
    const { monitor, status } = await started(verifier);
    expect(status.readiness()).toBe('verifying');
    expect(status.compromised).toBeNull();
    expect(warnings.mock.calls.flat().some((c) => c?.event === 'ledger-verification-incomplete')).toBe(true);
    await monitor.onModuleDestroy();
  });

  it('does not latch, and does not report up, when the walk could not run (a database problem is not damage)', async () => {
    const verifier = new FakeVerifier(['a'], (tenantId, options) => {
      if (options.mode === 'full') throw Object.assign(new Error('terminating connection'), { code: '57P01' });
      return outcome(tenantId);
    });
    const { monitor, status } = await started(verifier);
    expect(status.compromised).toBeNull();
    expect(status.readiness()).toBe('verifying');
    expect(errors.mock.calls.flat().some((c) => c?.event === 'ledger-verification-error' && c.error === 'Error 57P01')).toBe(true);
    await monitor.onModuleDestroy();
  });

  it('writes no checkpoint once latched, for any later walk', async () => {
    const verifier = new FakeVerifier(['a'], (tenantId, options) => (options.mode === 'full' ? failed(tenantId) : outcome(tenantId)));
    const { monitor } = await started(verifier);
    verifier.answer = (tenantId, options) => outcome(tenantId, { mode: options.mode ?? 'tail' });
    await monitor.verifyNow('a', true);
    expect(verifier.calls.at(-1)!.options.recordCheckpoint).toBe(false);
    await monitor.onModuleDestroy();
  });
});

describe('LedgerMonitor: the timer', () => {
  const walks = (v: FakeVerifier) => v.full.length;

  it('runs a full walk every interval, jittered between 90% and 110%', async () => {
    jest.useFakeTimers();
    const random = jest.spyOn(Math, 'random').mockReturnValue(0); // the shortest delay: 900 ms
    const verifier = new FakeVerifier(['a']);
    const { monitor } = await started(verifier, { fullIntervalMs: 1000 });
    expect(walks(verifier)).toBe(1);
    await jest.advanceTimersByTimeAsync(899);
    expect(walks(verifier)).toBe(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(walks(verifier)).toBe(2);
    expect(verifier.full[1]!.options).toMatchObject({ mode: 'full', recordCheckpoint: true });
    random.mockReturnValue(1); // the delay after the NEXT walk is the longest: 1100 ms (the one already armed is still 900)
    await jest.advanceTimersByTimeAsync(900);
    expect(walks(verifier)).toBe(3);
    await jest.advanceTimersByTimeAsync(1099);
    expect(walks(verifier)).toBe(3);
    await jest.advanceTimersByTimeAsync(1);
    expect(walks(verifier)).toBe(4);
    await monitor.onModuleDestroy();
  });

  it('has no timer when the interval is 0, and the timer never keeps the process alive', async () => {
    jest.useFakeTimers();
    const off = await started(new FakeVerifier(['a']), { fullIntervalMs: 0 });
    expect(jest.getTimerCount()).toBe(0);
    await off.monitor.onModuleDestroy();
    jest.useRealTimers();
    const on = await started(new FakeVerifier(['a']), { fullIntervalMs: 3_600_000 });
    const timer = (on.monitor as unknown as { timer: NodeJS.Timeout }).timer;
    expect(timer.hasRef()).toBe(false);
    await on.monitor.onModuleDestroy();
  });

  it('skips a scheduled walk while the previous one is still running (and says so)', async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    const hold = gate<VerifyResult>();
    let first = true;
    const verifier = new FakeVerifier(['a'], (tenantId, options) => {
      if (options.mode === 'full' && first) {
        first = false;
        return hold.promise;
      }
      return outcome(tenantId, { mode: options.mode ?? 'tail' });
    });
    const { monitor } = build(verifier, { fullIntervalMs: 1000 });
    await monitor.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(1000); // the timer fires while the start-up walk still holds
    expect(verifier.full).toHaveLength(1);
    expect(warnings.mock.calls.flat().some((c) => c?.event === 'ledger-verification-skipped')).toBe(true);
    hold.release(outcome('a', { mode: 'full' }));
    await monitor.idle();
    await monitor.onModuleDestroy();
  });

  it('stops the timer when the application shuts down', async () => {
    jest.useFakeTimers();
    const verifier = new FakeVerifier(['a']);
    const { monitor } = await started(verifier, { fullIntervalMs: 1000 });
    await monitor.onModuleDestroy();
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(5000);
    expect(verifier.full).toHaveLength(1);
  });
});

describe('LedgerMonitor: one verification at a time, and an admin check', () => {
  it('never runs two verifications at once, across the start check, the background walk and an admin check', async () => {
    const verifier = new FakeVerifier(['a', 'b', 'c'], async (tenantId, options) => {
      await new Promise((resolve) => setImmediate(resolve));
      return outcome(tenantId, { mode: options.mode ?? 'tail' });
    });
    const { monitor } = build(verifier);
    await monitor.onApplicationBootstrap();
    await Promise.allSettled([monitor.verifyNow('a', true), monitor.verifyNow('b', false), monitor.idle()]);
    await monitor.idle();
    expect(verifier.maxActive).toBe(1);
    await monitor.onModuleDestroy();
  });

  it('answers an admin check with 503 PIPELINE_BUSY and a Retry-After while another is running, and works again afterwards', async () => {
    const hold = gate<VerifyResult>();
    const verifier = new FakeVerifier(['a']);
    const { monitor } = await started(verifier);
    verifier.answer = () => hold.promise;
    const first = monitor.verifyNow('a', true);
    const refused = await monitor.verifyNow('a', false).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(AppException);
    expect(refused).toMatchObject({ status: 503, code: 'PIPELINE_BUSY', retryAfterSeconds: 5 });
    hold.release(outcome('a', { mode: 'full' }));
    await expect(first).resolves.toMatchObject({ status: 'ok' });
    verifier.answer = (tenantId) => outcome(tenantId);
    await expect(monitor.verifyNow('a', false)).resolves.toMatchObject({ status: 'ok' });
    await monitor.onModuleDestroy();
  });

  it('is refused while the background walk holds the slot', async () => {
    const hold = gate<VerifyResult>();
    const verifier = new FakeVerifier(['a'], (tenantId, options) => (options.mode === 'full' ? hold.promise : outcome(tenantId)));
    const { monitor } = build(verifier);
    await monitor.onApplicationBootstrap();
    await Promise.resolve();
    await expect(monitor.verifyNow('a', false)).rejects.toMatchObject({ code: 'PIPELINE_BUSY' });
    hold.release(outcome('a', { mode: 'full' }));
    await monitor.idle();
    await monitor.onModuleDestroy();
  });

  it('asks for a full or a tail walk as told, within the on-demand budget, and records a checkpoint while open', async () => {
    const verifier = new FakeVerifier(['a']);
    const { monitor } = await started(verifier);
    await monitor.verifyNow('a', true);
    await monitor.verifyNow('a', false);
    const [full, tail] = verifier.calls.slice(-2).map((c) => c.options);
    expect(full).toMatchObject({ mode: 'full', budgetMs: 30_000, recordCheckpoint: true });
    expect(tail).toMatchObject({ mode: 'tail', budgetMs: 30_000, recordCheckpoint: true });
    await monitor.onModuleDestroy();
  });

  it('LATCHES on a failed admin check, still returns the failed result, and stops checkpoints', async () => {
    const verifier = new FakeVerifier(['a']);
    const { monitor, status } = await started(verifier);
    verifier.answer = (tenantId) => failed(tenantId);
    await expect(monitor.verifyNow('a', true)).resolves.toMatchObject({ status: 'failed' });
    expect(status.compromised).toMatchObject({ tenantId: 'a', source: 'on-demand', kind: 'payload-mismatch' });
    expect(status.readiness()).toBe('down');
    verifier.answer = (tenantId) => outcome(tenantId);
    await monitor.verifyNow('a', false);
    expect(verifier.calls.at(-1)!.options.recordCheckpoint).toBe(false);
    await monitor.onModuleDestroy();
  });

  it('does not latch on an incomplete admin check', async () => {
    const verifier = new FakeVerifier(['a']);
    const { monitor, status } = await started(verifier);
    verifier.answer = (tenantId) => outcome(tenantId, { status: 'incomplete', mode: 'full' });
    await expect(monitor.verifyNow('a', true)).resolves.toMatchObject({ status: 'incomplete' });
    expect(status.compromised).toBeNull();
    await monitor.onModuleDestroy();
  });
});

describe('LedgerMonitor: shutdown', () => {
  it('aborts a walk in progress instead of waiting for it, closes the verifier, and does not report the stopped walk as complete', async () => {
    const verifier = new FakeVerifier(['a'], (tenantId, options) => (options.mode === 'full'
      ? new Promise<VerifyResult>((resolve) => options.signal!.addEventListener('abort', () => resolve(outcome(tenantId, { status: 'incomplete', mode: 'full' }))))
      : outcome(tenantId)));
    const { monitor, status } = build(verifier);
    await monitor.onApplicationBootstrap();
    await monitor.onModuleDestroy();
    expect(verifier.closed).toBe(true);
    expect(verifier.full[0]!.options.signal!.aborted).toBe(true);
    expect(status.readiness()).toBe('verifying');
  });
});
