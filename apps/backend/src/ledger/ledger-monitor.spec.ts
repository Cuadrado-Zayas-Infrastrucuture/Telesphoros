import { Logger } from '@nestjs/common';
import { AppException } from '../common/app-exception';
import { LedgerMonitor, type LedgerWatchConfig, type VerifierPort } from './ledger-monitor';
import { type Compromise, LedgerStatus, type OpenIncident } from './ledger-status';
import type { VerifyOptions, VerifyResult } from './verifier';

// The ledger watch's decisions, with a fake verifier so every outcome (damage, running out of time, a failing login, two callers at once)
// can be produced on demand. The real verifier against real tampering is test/db/ledger-watch.pg-spec.ts. Synthetic data only.

const config = (over: Partial<LedgerWatchConfig> = {}): LedgerWatchConfig => ({
  production: false,
  startupBudgetMs: 20_000,
  fullIntervalMs: 0,
  fullBudgetMs: 900_000,
  onDemandBudgetMs: 30_000,
  fullWalkAtOrBelowEvents: 50_000,
  incidentPollMs: 0,
  ...over,
});

const outcome = (tenantId: string, over: Partial<VerifyResult> = {}): VerifyResult => ({
  tenantId,
  status: 'ok',
  mode: 'tail',
  headSeq: '5',
  headHash: 'a'.repeat(64),
  eventsChecked: 5,
  failures: [],
  checkpointId: null,
  ...over,
});
const failed = (tenantId: string): VerifyResult =>
  outcome(tenantId, {
    status: 'failed',
    failures: [
      { kind: 'payload-mismatch', seq: '9' },
      { kind: 'head-mismatch', seq: '12' },
    ],
  });

type Answer = (tenantId: string, options: VerifyOptions) => Promise<VerifyResult> | VerifyResult;

class FakeVerifier implements VerifierPort {
  calls: Array<{ tenantId: string; options: VerifyOptions }> = [];
  closed = false;
  active = 0;
  maxActive = 0;
  failTenants: Error | null = null;
  /** The database's open incidents, as the fake keeps them (the real ones are in test/db/ledger-incidents.pg-spec.ts). */
  incidents: OpenIncident[] = [];
  recorded: Array<Pick<Compromise, 'tenantId' | 'kind' | 'seq' | 'source'>> = [];
  failRecord: Error | null = null;
  failOpen: Error | null = null;
  constructor(
    public tenantIds: string[],
    public answer: Answer = (tenantId, options) => outcome(tenantId, { mode: options.mode ?? 'tail' }),
  ) {}
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
  async recordIncident(finding: Pick<Compromise, 'tenantId' | 'kind' | 'seq' | 'source'>): Promise<string> {
    if (this.failRecord) throw this.failRecord;
    this.recorded.push(finding);
    const open = this.incidents.find((i) => i.scope === 'tenant' && i.tenantId === finding.tenantId);
    if (open) return open.id;
    const id = `incident-${this.incidents.length + 1}`;
    this.incidents.push({ id, scope: 'tenant', tenantId: finding.tenantId, kind: finding.kind, seq: finding.seq, source: finding.source, detectedAt: new Date(0) });
    return id;
  }
  async openIncidents(): Promise<OpenIncident[]> {
    if (this.failOpen) throw this.failOpen;
    return [...this.incidents];
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  get tail() {
    return this.calls.filter((c) => c.options.mode === 'tail');
  }
  /** The checkpoint checks that decide the start: tail mode, no full-walk threshold. */
  get checkpointChecks() {
    return this.tail.filter((c) => c.options.fullWalkAtOrBelow === undefined);
  }
  /** The strengthening full walks of small chains at start: tail mode WITH the full-walk threshold. */
  get startFullWalks() {
    return this.tail.filter((c) => c.options.fullWalkAtOrBelow !== undefined);
  }
  get full() {
    return this.calls.filter((c) => c.options.mode === 'full');
  }
}

/** Resolves once the background walk has called the verifier (bounded: it fails instead of waiting for ever). */
async function untilWalking(verifier: FakeVerifier): Promise<void> {
  for (let turn = 0; turn < 200 && verifier.full.length === 0; turn++) await Promise.resolve();
  if (verifier.full.length === 0) throw new Error('the background walk never started');
}

/** A promise a test settles by hand. */
function gate<T = void>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
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
    expect(() => status.assertOpen('t')).not.toThrow();
    await monitor.onModuleDestroy();
  });

  it('refuses an admin check as an installation fault', async () => {
    await expect(build(undefined).monitor.verifyNow('t', false)).rejects.toMatchObject({ status: 500, code: 'PIPELINE_MISCONFIGURED' });
  });
});

describe('LedgerMonitor: the check at start', () => {
  it('checks each tenant from its checkpoint within the budget, then walks small chains in full within half of it, and then reports ready (verifying, then up)', async () => {
    const verifier = new FakeVerifier(['a', 'b']);
    const { monitor, status } = build(verifier);
    await monitor.onApplicationBootstrap();
    expect(verifier.checkpointChecks.map((c) => c.tenantId)).toEqual(['a', 'b']);
    expect(verifier.checkpointChecks[0]!.options).toMatchObject({ mode: 'tail' });
    expect(verifier.checkpointChecks[0]!.options.budgetMs).toBeLessThanOrEqual(20_000);
    expect(verifier.startFullWalks.map((c) => c.tenantId)).toEqual(['a', 'b']);
    expect(verifier.startFullWalks[0]!.options).toMatchObject({ mode: 'tail', fullWalkAtOrBelow: 50_000 });
    expect(verifier.startFullWalks[0]!.options.budgetMs).toBeLessThanOrEqual(10_000); // half the start budget
    expect(verifier.tail.every((c) => c.options.recordCheckpoint === undefined)).toBe(true); // the start check writes nothing
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
    expect(verifier.tail.map((c) => [c.tenantId, c.options.budgetMs])).toEqual([
      ['a', 20_000],
      ['b', 12_000],
      ['c', 4_000],
    ]);
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
    it('warns and carries on after a failure, but contains the tenant (its writes stop, readiness fails for the unverified start), records it, and still runs the background walk', async () => {
      const verifier = new FakeVerifier(['a'], (tenantId, options) => (options.mode === 'tail' ? failed(tenantId) : outcome(tenantId, { mode: 'full' })));
      const { monitor, status } = build(verifier);
      await expect(monitor.onApplicationBootstrap()).resolves.toBeUndefined();
      await monitor.idle();
      expect(status.tailState).toBe('failed');
      expect(status.compromised).toMatchObject({ kind: 'payload-mismatch', seq: '9' });
      expect(status.readiness()).toBe('down');
      expect(() => status.assertOpen('a')).toThrow();
      expect(verifier.recorded).toEqual([{ tenantId: 'a', kind: 'payload-mismatch', seq: '9', source: 'startup' }]);
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

describe('LedgerMonitor: full walks at start', () => {
  /** A fake clock the fake verifier advances: a checkpoint check costs `tailMs`, a full walk of a small chain `fullMs`. A walk given less time than it costs is incomplete. */
  function timed(tenants: string[], tailMs: number, fullMs: number, extra?: (tenantId: string, options: VerifyOptions) => VerifyResult | undefined) {
    let clock = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    return new FakeVerifier(tenants, (tenantId, options) => {
      const preset = extra?.(tenantId, options);
      if (preset) return preset;
      const full = options.fullWalkAtOrBelow !== undefined;
      const cost = full ? fullMs : tailMs;
      if (options.budgetMs !== undefined && options.budgetMs < cost) {
        clock += options.budgetMs;
        return outcome(tenantId, { status: 'incomplete', mode: full ? 'full' : 'tail' });
      }
      clock += cost;
      return outcome(tenantId, { mode: full ? 'full' : 'tail' });
    });
  }

  it('does not refuse a production start when the full walks of many small chains do not fit: it checks them from their checkpoints, says how many are left, and the background pass walks them all', async () => {
    const tenants = Array.from({ length: 10 }, (_, i) => `t${i}`);
    const verifier = timed(tenants, 10, 6_000); // ten small chains: 60 s of full walks against a 20 s budget (the old wall)
    const { monitor, status } = build(verifier, { production: true });
    await expect(monitor.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(status.tailState).toBe('ok');
    const line = warnings.mock.calls.flat().find((c) => c?.event === 'ledger-startup-full-walks-deferred');
    expect(line).toMatchObject({ fullWalks: 1, deferred: 9 }); // the 10 s allowance: one whole walk, the second cut short, the rest not started
    expect(JSON.stringify(warnings.mock.calls)).not.toContain('"t0"'); // counts only, no tenant names
    await monitor.idle();
    expect(verifier.full.map((c) => c.tenantId)).toEqual(tenants); // the background pass walks every tenant in full
    await monitor.onModuleDestroy();
  });

  it('control: when everything fits, no walk is deferred and nothing is logged about it', async () => {
    const verifier = timed(['a', 'b', 'c'], 10, 2_000);
    const { monitor, status } = build(verifier, { production: true });
    await monitor.onApplicationBootstrap();
    expect(status.tailState).toBe('ok');
    expect(verifier.startFullWalks).toHaveLength(3);
    expect(warnings.mock.calls.flat().some((c) => c?.event === 'ledger-startup-full-walks-deferred')).toBe(false);
    await monitor.idle();
    await monitor.onModuleDestroy();
  });

  it('gives the full walks half the start budget from when they begin, whatever the checkpoint checks used of theirs', async () => {
    const verifier = timed(['a', 'b'], 9_000, 1_000); // checkpoint checks use 18 of the 20 s
    const { monitor } = build(verifier, { production: true });
    await monitor.onApplicationBootstrap();
    expect(verifier.checkpointChecks.map((c) => c.options.budgetMs)).toEqual([20_000, 11_000]);
    expect(verifier.startFullWalks.map((c) => c.options.budgetMs)).toEqual([10_000, 9_000]); // a separate 10 s, not the 2 s that were left
    await monitor.idle();
    await monitor.onModuleDestroy();
    const halved = timed(['a'], 10, 10);
    const small = build(halved, { startupBudgetMs: 8_000 });
    await small.monitor.onApplicationBootstrap();
    expect(halved.startFullWalks[0]!.options.budgetMs).toBe(4_000);
    await small.monitor.idle();
    await small.monitor.onModuleDestroy();
  });

  it('still refuses a production start when a small chain fails its full walk, records it first, and names no tenant', async () => {
    const verifier = timed(['tenant-secret-name'], 10, 100, (tenantId, options) => (options.fullWalkAtOrBelow !== undefined ? failed(tenantId) : undefined));
    const { monitor, status } = build(verifier, { production: true });
    const error = await monitor.onApplicationBootstrap().catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/failed.*payload-mismatch at sequence 9/);
    expect((error as Error).message).not.toContain('tenant-secret-name');
    expect(status.tailState).toBe('failed');
    expect(verifier.recorded).toEqual([{ tenantId: 'tenant-secret-name', kind: 'payload-mismatch', seq: '9', source: 'startup' }]);
    expect(verifier.full).toEqual([]); // nothing runs in the background after a refused start
  });

  it('does not start the full walks when a checkpoint check already failed (the start is refused or the tenant contained)', async () => {
    const verifier = timed(['a', 'b'], 10, 100, (tenantId, options) => (tenantId === 'a' && options.fullWalkAtOrBelow === undefined ? failed(tenantId) : undefined));
    const { monitor } = build(verifier); // not production: it carries on
    await monitor.onApplicationBootstrap();
    expect(verifier.startFullWalks).toEqual([]);
    await monitor.idle();
    await monitor.onModuleDestroy();
  });

  it('still refuses a production start when a checkpoint check cannot finish, and a deferred full walk is never mistaken for that', async () => {
    const verifier = timed(['a'], 25_000, 100); // the checkpoint check itself is longer than the whole budget
    await expect(build(verifier, { production: true }).monitor.onApplicationBootstrap()).rejects.toThrow(/incomplete/);
    expect(verifier.startFullWalks).toEqual([]);
  });

  it('does not walk again, in full, a chain that the checkpoint check already walked in full (no checkpoint yet)', async () => {
    const verifier = timed(['a', 'b'], 10, 100, (tenantId, options) =>
      tenantId === 'a' && options.fullWalkAtOrBelow === undefined ? outcome(tenantId, { mode: 'full' }) : undefined,
    );
    const { monitor } = build(verifier);
    await monitor.onApplicationBootstrap();
    expect(verifier.startFullWalks.map((c) => c.tenantId)).toEqual(['b']);
    await monitor.idle();
    await monitor.onModuleDestroy();
  });

  it('does not walk a contained tenant at start (its full walk goes on in the background)', async () => {
    const verifier = timed(['a', 'b', 'c'], 10, 6_000);
    verifier.incidents = [{ id: 'i-a', scope: 'tenant', tenantId: 'a', kind: 'payload-mismatch', seq: '9', source: 'background', detectedAt: new Date(0) }];
    const { monitor } = build(verifier, { production: true });
    await monitor.onApplicationBootstrap();
    expect(verifier.startFullWalks.map((c) => c.tenantId)).not.toContain('a');
    await monitor.idle();
    await monitor.onModuleDestroy();
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

  it('CONTAINS the failed tenant: logs the kind and sequence only, records the incident, keeps the other tenant working, and readiness says "contained"', async () => {
    const verifier = new FakeVerifier(['a', 'b'], (tenantId, options) =>
      options.mode === 'full' && tenantId === 'a'
        ? { ...failed(tenantId), failures: [{ kind: 'payload-mismatch', seq: '9', value: 'SECRET-NOTE-TEXT' } as never] }
        : outcome(tenantId, { mode: options.mode ?? 'tail' }),
    );
    const { monitor, status } = await started(verifier);
    expect(status.compromised).toMatchObject({ tenantId: 'a', kind: 'payload-mismatch', seq: '9', source: 'background' });
    expect(status.readiness()).toBe('contained');
    expect(() => status.assertOpen('a')).toThrow();
    expect(() => status.assertOpen('b')).not.toThrow();
    expect(verifier.recorded).toEqual([{ tenantId: 'a', kind: 'payload-mismatch', seq: '9', source: 'background' }]);
    expect(verifier.full.map((c) => [c.tenantId, c.options.recordCheckpoint])).toEqual([
      ['a', true],
      ['b', true],
    ]); // a checkpoint only ever follows an ok walk
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

  it('names a chain that is longer than the verifier will walk, as an error, and still latches nothing', async () => {
    const verifier = new FakeVerifier(['a'], (tenantId, options) =>
      options.mode === 'full' ? outcome(tenantId, { status: 'incomplete', mode: 'full', eventsChecked: 1_000_000, incompleteReason: 'size' }) : outcome(tenantId),
    );
    const { monitor, status } = await started(verifier);
    expect(status.readiness()).toBe('verifying');
    expect(status.compromised).toBeNull();
    const logged = errors.mock.calls.flat().find((c) => c?.event === 'ledger-chain-over-size');
    expect(logged).toMatchObject({ event: 'ledger-chain-over-size', tenantId: 'a', mode: 'full', eventsChecked: 1_000_000 });
    expect(errors.mock.calls.flat().some((c) => c?.event === 'ledger-compromised')).toBe(false); // size is not damage: the damage alarm must stay quiet
    expect(warnings.mock.calls.flat().some((c) => c?.event === 'ledger-verification-incomplete')).toBe(false); // and it is not the generic "ran out of time" line
    await monitor.onModuleDestroy();
  });

  it('keeps running out of time as a warning, not the over-size error', async () => {
    const verifier = new FakeVerifier(['a'], (tenantId, options) =>
      options.mode === 'full' ? outcome(tenantId, { status: 'incomplete', mode: 'full', incompleteReason: 'time' }) : outcome(tenantId),
    );
    const { monitor } = await started(verifier);
    expect(warnings.mock.calls.flat().some((c) => c?.event === 'ledger-verification-incomplete')).toBe(true);
    expect(errors.mock.calls.flat().some((c) => c?.event === 'ledger-chain-over-size')).toBe(false);
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

  it('still asks for a checkpoint for a contained tenant: it is the evidence a person needs to clear the incident (the verifier writes one only after an ok walk)', async () => {
    const verifier = new FakeVerifier(['a'], (tenantId, options) => (options.mode === 'full' ? failed(tenantId) : outcome(tenantId)));
    const { monitor, status } = await started(verifier);
    expect(status.hasIncident('a')).toBe(true);
    verifier.answer = (tenantId, options) => outcome(tenantId, { mode: options.mode ?? 'tail' });
    await monitor.verifyNow('a', true);
    expect(verifier.calls.at(-1)!.options).toMatchObject({ mode: 'full', recordCheckpoint: true });
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

  it('makes a background walk WAIT for an admin check that is running, instead of running beside it', async () => {
    const verifier = new FakeVerifier(['a']);
    const { monitor } = await started(verifier);
    const hold = gate<VerifyResult>();
    verifier.answer = () => hold.promise;
    const admin = monitor.verifyNow('a', true);
    const before = verifier.calls.length;
    const pass = (monitor as unknown as { runFullPass(source: 'scheduled'): Promise<void> }).runFullPass('scheduled');
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(verifier.calls.length).toBe(before); // the walk has not started its first tenant: it is queued behind the admin check
    expect(verifier.maxActive).toBe(1);
    verifier.answer = (tenantId, options) => outcome(tenantId, { mode: options.mode ?? 'tail' });
    hold.release(outcome('a', { mode: 'full' }));
    await admin;
    await pass;
    expect(verifier.calls.length).toBe(before + 1); // it ran once the slot was free
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
    await untilWalking(verifier);
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

  it('CONTAINS the tenant on a failed admin check, records it, and still returns the failed result', async () => {
    const verifier = new FakeVerifier(['a']);
    const { monitor, status } = await started(verifier);
    verifier.answer = (tenantId) => failed(tenantId);
    await expect(monitor.verifyNow('a', true)).resolves.toMatchObject({ status: 'failed' });
    expect(status.compromised).toMatchObject({ tenantId: 'a', source: 'on-demand', kind: 'payload-mismatch' });
    expect(status.readiness()).toBe('contained');
    expect(verifier.recorded).toEqual([{ tenantId: 'a', kind: 'payload-mismatch', seq: '9', source: 'on-demand' }]);
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
    const verifier = new FakeVerifier(['a'], (tenantId, options) =>
      options.mode === 'full'
        ? new Promise<VerifyResult>((resolve) => options.signal!.addEventListener('abort', () => resolve(outcome(tenantId, { status: 'incomplete', mode: 'full' }))))
        : outcome(tenantId),
    );
    const { monitor, status } = build(verifier);
    await monitor.onApplicationBootstrap();
    await untilWalking(verifier);
    await monitor.onModuleDestroy();
    expect(verifier.closed).toBe(true);
    expect(verifier.full[0]!.options.signal!.aborted).toBe(true);
    expect(status.readiness()).toBe('verifying');
  });
});

describe('LedgerMonitor: containment shared through the database', () => {
  const open = (tenantId: string | null, over: Partial<OpenIncident> = {}): OpenIncident => ({
    id: `i-${tenantId ?? 'hold'}`,
    scope: tenantId === null ? 'global' : 'tenant',
    tenantId,
    kind: tenantId === null ? 'manual-hold' : 'payload-mismatch',
    seq: tenantId === null ? null : '9',
    source: tenantId === null ? 'manual' : 'background',
    detectedAt: new Date(0),
    ...over,
  });

  it("a sibling task's finding is mirrored at start: production STARTS with the tenant listed as contained, and does not re-judge it", async () => {
    const verifier = new FakeVerifier(['a', 'b'], (tenantId) => (tenantId === 'a' ? failed(tenantId) : outcome(tenantId)));
    verifier.incidents = [open('a')];
    const { monitor, status } = build(verifier, { production: true });
    await expect(monitor.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(verifier.tail.map((c) => c.tenantId)).toEqual(['b', 'b']); // 'a' is already known and recorded (no second verdict, no restart loop); 'b' is checked in both phases
    expect(status.tailState).toBe('ok');
    expect(status.readiness()).toBe('contained');
    expect(() => status.assertOpen('a')).toThrow();
    expect(() => status.assertOpen('b')).not.toThrow();
    const line = warnings.mock.calls.flat().find((c) => c?.event === 'ledger-contained-at-start');
    expect(line).toMatchObject({ containedTenants: 1, globalHold: false });
    expect(JSON.stringify(warnings.mock.calls)).not.toContain('"a"'); // the count, not the tenant
    await monitor.idle();
    await monitor.onModuleDestroy();
  });

  it('control: a NEW failure at start is still refused in production, and is recorded first so the next start sees it as contained', async () => {
    const verifier = new FakeVerifier(['a'], (tenantId) => failed(tenantId));
    await expect(build(verifier, { production: true }).monitor.onApplicationBootstrap()).rejects.toThrow(/failed.*payload-mismatch at sequence 9/);
    expect(verifier.incidents.map((i) => i.tenantId)).toEqual(['a']);
    const second = build(verifier, { production: true });
    await expect(second.monitor.onApplicationBootstrap()).resolves.toBeUndefined();
    await second.monitor.idle();
    await second.monitor.onModuleDestroy();
  });

  it('a global hold lets the instance start, but readiness is down and every tenant is refused', async () => {
    const verifier = new FakeVerifier(['a', 'b']);
    verifier.incidents = [open(null)];
    const { monitor, status } = build(verifier, { production: true });
    await expect(monitor.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(verifier.checkpointChecks.map((c) => c.tenantId)).toEqual(['a', 'b']); // still judged: a hold says nothing about the chains
    expect(status.readiness()).toBe('down');
    expect(() => status.assertOpen('a')).toThrow();
    expect(() => status.assertOpen('b')).toThrow();
    await monitor.idle();
    await monitor.onModuleDestroy();
  });

  it('a contained tenant that still fails does not keep the instance "verifying" for ever, and does not page twice', async () => {
    const verifier = new FakeVerifier(['a', 'b'], (tenantId, options) =>
      tenantId === 'a' && options.mode === 'full' ? failed(tenantId) : outcome(tenantId, { mode: options.mode ?? 'tail' }),
    );
    const { monitor, status } = await started(verifier);
    expect(errors.mock.calls.flat().filter((c) => c?.event === 'ledger-compromised')).toHaveLength(1);
    await monitor.verifyNow('a', true); // fails again while contained
    expect(errors.mock.calls.flat().filter((c) => c?.event === 'ledger-compromised')).toHaveLength(1);
    expect(warnings.mock.calls.flat().some((c) => c?.event === 'ledger-incident-still-open' && c.tenantId === 'a')).toBe(true);
    expect(verifier.recorded).toHaveLength(1);
    expect(status.readiness()).toBe('contained');
    await monitor.onModuleDestroy();
  });

  it('refuses at once even when the database cannot be told (the process never writes to a damaged chain while waiting), and logs the class of the failure only', async () => {
    const verifier = new FakeVerifier(['a'], (tenantId, options) => (options.mode === 'full' ? failed(tenantId) : outcome(tenantId)));
    verifier.failRecord = Object.assign(new Error('connection refused to db.internal'), { code: 'ECONNREFUSED' });
    const { monitor, status } = await started(verifier);
    expect(() => status.assertOpen('a')).toThrow();
    expect(status.unrecorded().map((f) => f.tenantId)).toEqual(['a']);
    expect(errors.mock.calls.flat().some((c) => c?.event === 'ledger-incident-record-failed' && c.tenantId === 'a')).toBe(true);
    expect(JSON.stringify(errors.mock.calls)).not.toContain('db.internal'); // the class and code only
    await monitor.onModuleDestroy();
  });

  it('retries recording at the start of the next full pass, then holds the tenant because the database says so', async () => {
    jest.useFakeTimers();
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const verifier = new FakeVerifier(['a'], (tenantId, options) => (options.mode === 'full' ? failed(tenantId) : outcome(tenantId)));
    verifier.failRecord = new Error('db down');
    const { monitor, status } = await started(verifier, { fullIntervalMs: 1000 });
    expect(status.unrecorded()).toHaveLength(1);
    verifier.failRecord = null;
    await jest.advanceTimersByTimeAsync(900); // the scheduled pass starts by syncing
    expect(status.unrecorded()).toEqual([]);
    expect(verifier.incidents.map((i) => i.tenantId)).toEqual(['a']);
    await monitor.onModuleDestroy();
  });

  it("the poll picks up a sibling's finding and a person's clearance without a walk of its own", async () => {
    jest.useFakeTimers();
    const verifier = new FakeVerifier(['a', 'b']);
    const { monitor, status } = await started(verifier, { incidentPollMs: 5_000 });
    expect(status.readiness()).toBe('up');
    verifier.incidents = [open('b')]; // another task found damage
    await jest.advanceTimersByTimeAsync(5_000);
    expect(() => status.assertOpen('b')).toThrow();
    expect(status.readiness()).toBe('contained');
    verifier.incidents = []; // a person cleared it
    await jest.advanceTimersByTimeAsync(5_000);
    expect(() => status.assertOpen('b')).not.toThrow();
    expect(status.readiness()).toBe('up');
    await monitor.onModuleDestroy();
  });

  it('after a person clears a tenant that failed its full walk, the instance is "up" at once: the expected failure never left it "verifying"', async () => {
    jest.useFakeTimers();
    const verifier = new FakeVerifier(['a'], (tenantId, options) => (options.mode === 'full' ? failed(tenantId) : outcome(tenantId)));
    const { monitor, status } = await started(verifier, { incidentPollMs: 5_000 });
    expect(status.readiness()).toBe('contained');
    verifier.incidents = []; // cleared by a person (and, in this test, the next full walk is far away)
    await jest.advanceTimersByTimeAsync(5_000);
    expect(status.readiness()).toBe('up');
    await monitor.onModuleDestroy();
  });

  it('keeps what it knows, and says so in the log, when the open incidents cannot be read', async () => {
    jest.useFakeTimers();
    const verifier = new FakeVerifier(['a']);
    verifier.incidents = [open('a')];
    const { monitor, status } = await started(verifier, { incidentPollMs: 5_000 });
    verifier.failOpen = Object.assign(new Error('timeout talking to db.internal'), { code: '57014' });
    await jest.advanceTimersByTimeAsync(5_000);
    expect(() => status.assertOpen('a')).toThrow(); // unchanged
    const line = warnings.mock.calls.flat().find((c) => c?.event === 'ledger-incident-sync-failed');
    expect(line).toMatchObject({ error: 'Error 57014' });
    expect(JSON.stringify(warnings.mock.calls)).not.toContain('db.internal');
    await monitor.onModuleDestroy();
  });
});
