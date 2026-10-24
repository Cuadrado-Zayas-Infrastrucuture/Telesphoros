import { Logger } from '@nestjs/common';
import { LedgerMonitor, type LedgerWatchConfig, type PassLock, type VerifierPort } from './ledger-monitor';
import { LedgerStatus } from './ledger-status';
import type { VerifyOptions, VerifyResult } from './verifier';

// Audit items 23 and 32: every task walked the whole ledger the moment it started, all at once, and again on its timer, with nothing to space the
// tasks out. These tests use fake verifiers that share one fake lock; the real lock against PostgreSQL is test/db/ledger-pass-lock.pg-spec.ts.

const config = (over: Partial<LedgerWatchConfig> = {}): LedgerWatchConfig => ({
  production: false, startupBudgetMs: 20_000, fullIntervalMs: 0, fullBudgetMs: 900_000, onDemandBudgetMs: 30_000, fullWalkAtOrBelowEvents: 50_000, incidentPollMs: 0,
  bootPassJitterMs: 0, passLockWaitMs: 60_000, passLockRetryMs: 1_000, ...over,
});

const ok = (tenantId: string, options: VerifyOptions): VerifyResult => ({
  tenantId, status: 'ok', mode: options.mode ?? 'tail', headSeq: '5', headHash: 'a'.repeat(64), eventsChecked: 5, failures: [], checkpointId: null,
});

/** One lock that every fake verifier in a test shares, as the database's advisory lock is shared by every task. */
class LockHub {
  holder: string | null = null;
  grants: string[] = [];
  releases = 0;
  failAcquire: Error | null = null;
}

class Fake implements VerifierPort {
  fullStarted = 0;
  fullActive = 0;
  holdFull: Promise<void> | null = null;
  constructor(readonly name: string, readonly hub: LockHub, readonly walked: { active: number; max: number }) {}
  async tenants() { return ['t1']; }
  async verify(tenantId: string, options: VerifyOptions = {}): Promise<VerifyResult> {
    if (options.mode === 'full') {
      this.fullStarted += 1;
      this.walked.active += 1;
      this.walked.max = Math.max(this.walked.max, this.walked.active);
      try { await this.holdFull; } finally { this.walked.active -= 1; }
    }
    return ok(tenantId, options);
  }
  async recordIncident() { return 'i'; }
  async openIncidents() { return []; }
  async close() { /* nothing to close */ }
  async acquirePassLock(): Promise<PassLock | undefined> {
    if (this.hub.failAcquire) throw this.hub.failAcquire;
    if (this.hub.holder !== null) return undefined;
    this.hub.holder = this.name;
    this.hub.grants.push(this.name);
    return { release: async () => { this.hub.holder = null; this.hub.releases += 1; } };
  }
}

let warnings: jest.SpyInstance;
beforeEach(() => {
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  warnings = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.useFakeTimers();
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

const monitorFor = (verifier: VerifierPort, over: Partial<LedgerWatchConfig> = {}) => new LedgerMonitor(config(over), verifier, new LedgerStatus());
const warned = (event: string) => warnings.mock.calls.some(([line]) => (line as { event?: string })?.event === event);
const settle = () => jest.advanceTimersByTimeAsync(0);

describe('the full walk after start', () => {
  it('begins after a random delay of up to the jitter, not at once', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    const verifier = new Fake('a', new LockHub(), { active: 0, max: 0 });
    const monitor = monitorFor(verifier, { bootPassJitterMs: 60_000 });
    await monitor.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(29_999);
    expect(verifier.fullStarted).toBe(0);
    await jest.advanceTimersByTimeAsync(1);
    expect(verifier.fullStarted).toBe(1);
    await monitor.onModuleDestroy();
  });

  it('holds the pass lock for the whole walk and releases it afterwards', async () => {
    const hub = new LockHub();
    const verifier = new Fake('a', hub, { active: 0, max: 0 });
    let finish!: () => void;
    verifier.holdFull = new Promise<void>((resolve) => { finish = resolve; });
    const monitor = monitorFor(verifier);
    await monitor.onApplicationBootstrap();
    await settle();
    expect(hub.holder).toBe('a');
    expect(verifier.fullActive + verifier.fullStarted).toBeGreaterThan(0);
    finish();
    await monitor.idle();
    expect(hub.holder).toBeNull();
    expect(hub.releases).toBe(1);
    await monitor.onModuleDestroy();
  });

  it('lets two tasks walk one after the other, never together, and both walk', async () => {
    const hub = new LockHub();
    const walked = { active: 0, max: 0 };
    const [a, b] = [new Fake('a', hub, walked), new Fake('b', hub, walked)];
    let finishA!: () => void;
    a.holdFull = new Promise<void>((resolve) => { finishA = resolve; });
    const [ma, mb] = [monitorFor(a), monitorFor(b)];
    await ma.onApplicationBootstrap();
    await mb.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(a.fullStarted).toBe(1);
    expect(b.fullStarted).toBe(0); // waiting for the lock, not walking
    finishA();
    await jest.advanceTimersByTimeAsync(2_000);
    await ma.idle();
    await mb.idle();
    expect(b.fullStarted).toBe(1);
    expect(walked.max).toBe(1);
    expect(hub.grants).toEqual(['a', 'b']);
    await ma.onModuleDestroy();
    await mb.onModuleDestroy();
  });

  it('walks anyway when the lock stays taken past the wait limit: the lock only ever delays a check', async () => {
    const hub = new LockHub();
    hub.holder = 'someone-who-never-lets-go';
    const verifier = new Fake('a', hub, { active: 0, max: 0 });
    const monitor = monitorFor(verifier, { passLockWaitMs: 3_000 });
    await monitor.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(2_500);
    expect(verifier.fullStarted).toBe(0);
    await jest.advanceTimersByTimeAsync(3_000);
    await monitor.idle();
    expect(verifier.fullStarted).toBe(1);
    expect(warned('ledger-pass-lock-timeout')).toBe(true);
    await monitor.onModuleDestroy();
  });

  it('walks anyway when the lock cannot be asked for at all', async () => {
    const hub = new LockHub();
    hub.failAcquire = new Error('connection refused');
    const verifier = new Fake('a', hub, { active: 0, max: 0 });
    const monitor = monitorFor(verifier);
    await monitor.onApplicationBootstrap();
    await monitor.idle();
    expect(verifier.fullStarted).toBe(1);
    expect(warned('ledger-pass-lock-error')).toBe(true);
    await monitor.onModuleDestroy();
  });

  it('gives the lock back when the walk fails', async () => {
    const hub = new LockHub();
    const verifier = new Fake('a', hub, { active: 0, max: 0 });
    verifier.tenants = async () => { throw new Error('tenants unreadable'); };
    const monitor = monitorFor(verifier);
    await monitor.onApplicationBootstrap().catch(() => undefined);
    await monitor.idle();
    expect(hub.holder).toBeNull();
    await monitor.onModuleDestroy();
  });

  it('stops waiting for the lock at shutdown, without walking', async () => {
    const hub = new LockHub();
    hub.holder = 'other';
    const verifier = new Fake('a', hub, { active: 0, max: 0 });
    const monitor = monitorFor(verifier);
    await monitor.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(2_000);
    await monitor.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(120_000);
    expect(verifier.fullStarted).toBe(0);
  });
});
