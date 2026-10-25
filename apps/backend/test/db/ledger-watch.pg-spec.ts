import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { Client } from 'pg';
import { Database } from '../../src/db/database';
import { LedgerMonitor, type LedgerWatchConfig, type VerifierPort } from '../../src/ledger/ledger-monitor';
import { LedgerStatus } from '../../src/ledger/ledger-status';
import { LedgerCompromisedError } from '../../src/ledger/ledger-types';
import { LedgerVerifier, type VerifyOptions, type VerifyResult } from '../../src/ledger/verifier';
import { PostgresLedgerRecordsRepository } from '../../src/storage/postgres/ledger-records.repository';
import { untilBlocked } from '../helpers/barrier';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { acceptanceFor, captureFor, evaluationFor, type SeededReport, seedLabReport } from '../helpers/ledger-fixtures';

// The ledger watch against a REAL database and a REAL verifier, with tampering done the way someone who can bypass every trigger would do
// it. The decisions themselves (budgets, queueing, timers) are in src/ledger/ledger-monitor.spec.ts with a fake verifier. Synthetic data only.

const config = (over: Partial<LedgerWatchConfig> = {}): LedgerWatchConfig => ({
  production: false,
  startupBudgetMs: 20_000,
  fullIntervalMs: 0,
  fullBudgetMs: 60_000,
  onDemandBudgetMs: 30_000,
  fullWalkAtOrBelowEvents: 50_000,
  incidentPollMs: 0,
  ...over,
});

/** The real verifier, recording what it was asked and what it found. */
type IncidentRecording = {
  finding: Parameters<LedgerVerifier['recordIncident']>[0];
  outcome: { status: 'recorded'; id: string } | { status: 'failed'; error: unknown } | null;
};

class RecordingVerifier implements VerifierPort {
  readonly results: Array<{ options: VerifyOptions; result: VerifyResult }> = [];
  readonly incidents: IncidentRecording[] = [];
  constructor(private readonly inner: LedgerVerifier) {}
  tenants() {
    return this.inner.tenants();
  }
  async verify(tenantId: string, options: VerifyOptions = {}) {
    const result = await this.inner.verify(tenantId, options);
    this.results.push({ options, result });
    return result;
  }
  async recordIncident(finding: Parameters<LedgerVerifier['recordIncident']>[0]) {
    const recording: IncidentRecording = { finding, outcome: null };
    this.incidents.push(recording);
    try {
      const id = await this.inner.recordIncident(finding);
      recording.outcome = { status: 'recorded', id };
      return id;
    } catch (error) {
      recording.outcome = { status: 'failed', error };
      throw error;
    }
  }
  openIncidents() {
    return this.inner.openIncidents();
  }
  close() {
    return this.inner.close();
  }
}

// Failures are asserted on through spies below; the console copy of each would only bury the test output.
beforeAll(() => Logger.overrideLogger(false));

let pg: EphemeralDatabase;
let database: Database;
let repo: PostgresLedgerRecordsRepository;

async function fresh() {
  pg = await createEphemeralDatabase();
  database = new Database({ url: pg.appUrl, ssl: 'disable' });
  repo = new PostgresLedgerRecordsRepository(database);
}
async function dispose() {
  await database.onModuleDestroy();
  await pg.drop();
}

/** A tenant with a capture, an accepted capture, an evaluation (with children), a correction, and a dispute with a note. */
async function chain(): Promise<{ tenantId: string; report: SeededReport; ids: Record<string, string> }> {
  const tenantId = `tenant-${randomUUID()}`;
  const report = await seedLabReport(pg.adminUrl, tenantId);
  const capture = captureFor(report);
  const c = await repo.insertCapture(tenantId, report.uploader, capture);
  const a = await repo.insertAcceptance(tenantId, 'syn-reviewer', acceptanceFor(c.record.id, capture, { note: 'checked against the page' }));
  const e = await repo.insertEvaluation(tenantId, 'syn-system', evaluationFor(report, c.record.id, a.record.id));
  const k = await repo.insertCorrection(tenantId, 'syn-reviewer', { evaluationId: e.record.id, kind: 'retraction', reasonCode: 'input-misread', note: 'misread' });
  const d = await repo.raiseDispute(tenantId, 'syn-reviewer', {
    guidelineId: 'syn-guideline',
    guidelineVersion: '1',
    guidelineContentSha256: 'a'.repeat(64),
    locator: { table: 'recommendations', row: 'poor' },
    note: 'cell looks wrong',
  });
  return { tenantId, report, ids: { capture: c.record.id, acceptance: a.record.id, evaluation: e.record.id, correction: k.record.id, dispute: d.record.id } };
}

const tamper = (work: (c: Client) => Promise<unknown>) =>
  withAdmin(pg.adminUrl, async (c) => {
    await c.query(`SET session_replication_role = replica`);
    await work(c);
  });

function watch(over: Partial<LedgerWatchConfig> = {}, status = new LedgerStatus()) {
  const verifier = new RecordingVerifier(LedgerVerifier.connect(pg.verifierUrl));
  const monitor = new LedgerMonitor(config(over), verifier, status);
  return { monitor, status, verifier };
}

/** Waits (bounded) for a condition that another timer in this process will make true. */
async function until(condition: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  if (!condition()) throw new Error('the condition did not become true in time');
}

async function waitForScheduledIncident(watcher: ReturnType<typeof watch>, tenantId: string): Promise<void> {
  let recording: IncidentRecording | undefined;
  await until(() => {
    recording ??= watcher.verifier.incidents.find((attempt) => attempt.finding.tenantId === tenantId && attempt.finding.source === 'scheduled');
    return recording?.outcome != null;
  });
  // Observe the first real call's outcome: a later successful sync must not hide its rejection.
  const outcome = recording!.outcome!;
  if (outcome.status === 'failed') throw outcome.error;
}

const openIncidentTenants = () =>
  withAdmin(pg.adminUrl, async (c) =>
    (await c.query(`SELECT tenant_id FROM ledger_incidents i WHERE NOT EXISTS (SELECT 1 FROM ledger_incident_clearances c WHERE c.incident_id = i.id) ORDER BY i.seq`)).rows.map(
      (r) => r.tenant_id as string,
    ),
  );

/** What a person does after an investigation: the operator login clears every open incident. */
async function clearIncidentsAsOperator(basis: string): Promise<void> {
  const operator = new Client({ connectionString: pg.operatorUrl });
  await operator.connect();
  try {
    const open = await operator.query(`SELECT id FROM ledger_incidents i WHERE NOT EXISTS (SELECT 1 FROM ledger_incident_clearances c WHERE c.incident_id = i.id)`);
    for (const row of open.rows) await operator.query(`SELECT ledger_clear_incident($1::uuid, $2)`, [row.id, basis]);
  } finally {
    await operator.end();
  }
}

const count = (table: string, tenantId: string) =>
  withAdmin(pg.adminUrl, async (c) => Number((await c.query(`SELECT count(*) AS n FROM ${table} WHERE tenant_id = $1`, [tenantId])).rows[0].n));

describe('ledger watch: an intact log', () => {
  beforeAll(fresh, 60_000);
  afterAll(dispose);

  it('passes the check at start in production, then walks everything in full and records a checkpoint for each tenant', async () => {
    const a = await chain();
    const b = await chain();
    const { monitor, status, verifier } = watch({ production: true });
    await monitor.onApplicationBootstrap();
    expect(status.tailState).toBe('ok');
    await monitor.idle();
    expect(status.readiness()).toBe('up');
    expect(verifier.results.filter((r) => r.options.mode === 'full').map((r) => r.result.status)).toEqual(expect.arrayContaining(['ok', 'ok']));
    expect(await count('ledger_checkpoints', a.tenantId)).toBeGreaterThanOrEqual(1);
    expect(await count('ledger_checkpoints', b.tenantId)).toBeGreaterThanOrEqual(1);
    await monitor.onModuleDestroy();
  });

  it('starts again after those checkpoints: every chain is checked from its checkpoint, a small one is then walked in FULL as well, and a large one is not', async () => {
    const checkpointChecks = (v: ReturnType<typeof watch>['verifier']) => v.results.filter((r) => r.options.mode === 'tail' && r.options.fullWalkAtOrBelow === undefined);
    const startWalks = (v: ReturnType<typeof watch>['verifier']) => v.results.filter((r) => r.options.mode === 'tail' && r.options.fullWalkAtOrBelow !== undefined);

    const small = watch({ production: true });
    await small.monitor.onApplicationBootstrap();
    await small.monitor.idle();
    expect(checkpointChecks(small.verifier).length).toBeGreaterThan(0);
    for (const { result } of checkpointChecks(small.verifier)) expect(result).toMatchObject({ status: 'ok', mode: 'tail' }); // the check that decides the start
    expect(Math.max(...checkpointChecks(small.verifier).map((t) => t.result.eventsChecked))).toBeLessThanOrEqual(2); // only what came after the checkpoint
    expect(startWalks(small.verifier).length).toBeGreaterThan(0);
    for (const { result } of startWalks(small.verifier)) expect(result).toMatchObject({ status: 'ok', mode: 'full' }); // then the strengthening walk
    await small.monitor.onModuleDestroy();

    const large = watch({ production: true, fullWalkAtOrBelowEvents: 0 });
    await large.monitor.onApplicationBootstrap();
    await large.monitor.idle();
    const largeTails = large.verifier.results.filter((r) => r.options.mode === 'tail');
    for (const { result } of largeTails) expect(result).toMatchObject({ status: 'ok', mode: 'tail' }); // no full walk at start for a chain over the threshold
    expect(Math.max(...largeTails.map((t) => t.result.eventsChecked))).toBeLessThanOrEqual(2);
    await large.monitor.onModuleDestroy();
  });

  it('refuses to start in production when the budget is already spent, without walking anything (control: the same log starts with a budget)', async () => {
    const spent = watch({ production: true, startupBudgetMs: 0 });
    await expect(spent.monitor.onApplicationBootstrap()).rejects.toThrow(/incomplete/);
    expect(spent.verifier.results).toEqual([]);
    expect(spent.status.readiness()).toBe('down');
    await spent.monitor.onModuleDestroy();

    const enough = watch({ production: true });
    await expect(enough.monitor.onApplicationBootstrap()).resolves.toBeUndefined();
    await enough.monitor.onModuleDestroy();
  });
});

describe('ledger watch: a tampered log', () => {
  type Attack = (c: Client, t: { tenantId: string; ids: Record<string, string> }) => Promise<unknown>;
  const attacks: Array<[string, Attack]> = [
    ['an edited record', (c, t) => c.query(`UPDATE report_captures SET text_scalars = text_scalars + 1 WHERE id = $1`, [t.ids.capture])],
    ['a deleted event', (c, t) => c.query(`DELETE FROM ledger_events WHERE tenant_id = $1 AND seq = 3`, [t.tenantId])],
    [
      'two events swapped',
      async (c, t) => {
        await c.query(`UPDATE ledger_events SET seq = 1000 WHERE tenant_id = $1 AND seq = 2`, [t.tenantId]);
        await c.query(`UPDATE ledger_events SET seq = 2 WHERE tenant_id = $1 AND seq = 3`, [t.tenantId]);
        await c.query(`UPDATE ledger_events SET seq = 3 WHERE tenant_id = $1 AND seq = 1000`, [t.tenantId]);
      },
    ],
    [
      'a child row added to an evaluation after the fact',
      (c, t) =>
        c.query(
          `INSERT INTO evaluation_results (tenant_id, evaluation_id, ordinal, drug, genes, outcome, reason_code, gene_evidence)
       VALUES ($1, $2, 9, 'x', '{}', 'no-guideline', 'no-guideline-for-drug', '[]')`,
          [t.tenantId, t.ids.evaluation],
        ),
    ],
    ['an edited note', (c, t) => c.query(`UPDATE event_notes SET body = 'rewritten' WHERE tenant_id = $1 AND body = 'cell looks wrong'`, [t.tenantId])],
  ];

  describe.each(attacks)('after %s', (_name, attack) => {
    let t: Awaited<ReturnType<typeof chain>>;
    // A fresh database for each test: a finding is recorded in the database and stays open until a person clears it, so tests cannot share one.
    beforeEach(async () => {
      await fresh();
      t = await chain();
      await tamper((c) => attack(c, t));
    }, 60_000);
    afterEach(dispose);

    it('production refuses to start, and says which kind of break and where, never a value', async () => {
      const { monitor, status } = watch({ production: true });
      const error = await monitor.onApplicationBootstrap().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/did not pass its check at start: failed \([a-z-]+( at sequence \d+)?\)/);
      expect((error as Error).message).not.toMatch(/rewritten|cell looks wrong|tenant-/);
      expect(status.compromised).not.toBeNull();
      await monitor.onModuleDestroy();
    });

    it('development carries on with the tenant contained: not ready after the failed start, new records refused and not stored, reads still work', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const err = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const status = new LedgerStatus();
      const { monitor } = watch({}, status);
      await monitor.onApplicationBootstrap();
      await monitor.idle();
      expect(status.compromised).toMatchObject({ source: 'startup' });
      expect(status.readiness()).toBe('down');
      expect(err.mock.calls.flat().some((c) => c?.event === 'ledger-compromised')).toBe(true);
      expect(JSON.stringify([...warn.mock.calls, ...err.mock.calls])).not.toMatch(/rewritten|cell looks wrong/);
      expect(await openIncidentTenants()).toEqual([t.tenantId]); // recorded in the database, not only remembered here

      const guarded = new PostgresLedgerRecordsRepository(database, status);
      const before = [await count('report_captures', t.tenantId), await count('ledger_events', t.tenantId)];
      const other = await seedLabReport(pg.adminUrl, t.tenantId);
      await expect(guarded.insertCapture(t.tenantId, other.uploader, captureFor(other))).rejects.toBeInstanceOf(LedgerCompromisedError);
      expect([await count('report_captures', t.tenantId), await count('ledger_events', t.tenantId)]).toEqual(before); // nothing was stored
      await expect(guarded.findCapture(t.tenantId, t.ids.capture)).resolves.toMatchObject({ id: t.ids.capture }); // reads work
      jest.restoreAllMocks();
      await monitor.onModuleDestroy();
    });

    it('a second task that never walked the tenant is stopped by the DATABASE; a restarted production task starts, with the tenant contained', async () => {
      const first = watch({ production: true });
      await expect(first.monitor.onApplicationBootstrap()).rejects.toThrow(/did not pass its check at start/); // finds it, records it, refuses to start
      await first.monitor.onModuleDestroy();
      expect(await openIncidentTenants()).toEqual([t.tenantId]);

      // A process whose own gate is open (it has heard nothing): the refusal comes from ledger_append itself, inside the transaction.
      const unaware = new PostgresLedgerRecordsRepository(database, new LedgerStatus());
      const other = await seedLabReport(pg.adminUrl, t.tenantId);
      const before = [await count('report_captures', t.tenantId), await count('ledger_events', t.tenantId)];
      await expect(unaware.insertCapture(t.tenantId, other.uploader, captureFor(other))).rejects.toBeInstanceOf(LedgerCompromisedError);
      expect([await count('report_captures', t.tenantId), await count('ledger_events', t.tenantId)]).toEqual(before);

      // The next start (the deployment's replacement task) does not loop: it mirrors the incident and starts.
      const restarted = watch({ production: true });
      await expect(restarted.monitor.onApplicationBootstrap()).resolves.toBeUndefined();
      expect(restarted.status.containedTenants()).toEqual([t.tenantId]);
      expect(restarted.status.readiness()).toBe('contained');
      await restarted.monitor.idle();
      await restarted.monitor.onModuleDestroy();

      // Control: a tenant without an incident writes normally in the same database.
      const neighbour = `tenant-${randomUUID()}`;
      const neighbourReport = await seedLabReport(pg.adminUrl, neighbour);
      await expect(unaware.insertCapture(neighbour, neighbourReport.uploader, captureFor(neighbourReport))).resolves.toBeDefined();
    });
  });
});

describe('ledger watch: damage that appears while it is running', () => {
  beforeAll(fresh, 60_000);
  afterAll(dispose);

  it('is found by the timer, contains the tenant, and stops new records; repairing the data does not reopen them: a person clears the incident, and only after a full walk that began later', async () => {
    const err = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    let monitor: LedgerMonitor | undefined;
    try {
      const t = await chain();
      const status = new LedgerStatus();
      const watcher = watch({ production: true, fullIntervalMs: 200, incidentPollMs: 100 }, status);
      monitor = watcher.monitor;
      await monitor.onApplicationBootstrap();
      await monitor.idle();
      expect(status.readiness()).toBe('up');

      await tamper((c) => c.query(`UPDATE report_captures SET text_scalars = text_scalars + 1 WHERE id = $1`, [t.ids.capture]));
      await until(() => status.compromised !== null); // bounded wait for the timer's walk
      expect(status.compromised).toMatchObject({ tenantId: t.tenantId, kind: 'payload-mismatch', source: 'scheduled' });
      expect(status.readiness()).toBe('contained');
      expect(err.mock.calls.flat().some((c) => c?.event === 'ledger-compromised' && c.tenantId === t.tenantId)).toBe(true);
      await waitForScheduledIncident(watcher, t.tenantId);
      expect(await openIncidentTenants()).toEqual([t.tenantId]);

      const guarded = new PostgresLedgerRecordsRepository(database, status);
      const report = await seedLabReport(pg.adminUrl, t.tenantId);
      await expect(guarded.insertCapture(t.tenantId, report.uploader, captureFor(report))).rejects.toBeInstanceOf(LedgerCompromisedError);

      // Repairing the data does not reopen the writes, and neither does a restart: a person decides, with a full walk as evidence.
      await tamper((c) => c.query(`UPDATE report_captures SET text_scalars = text_scalars - 1 WHERE id = $1`, [t.ids.capture]));
      await expect(monitor.verifyNow(t.tenantId, true)).resolves.toMatchObject({ status: 'ok', mode: 'full', checkpointId: expect.any(String) });
      await expect(guarded.insertCapture(t.tenantId, report.uploader, captureFor(report))).rejects.toBeInstanceOf(LedgerCompromisedError);
      const restarted = watch({ production: true });
      try {
        await restarted.monitor.onApplicationBootstrap();
        expect(restarted.status.containedTenants()).toEqual([t.tenantId]);
      } finally {
        await restarted.monitor.onModuleDestroy();
      }

      await clearIncidentsAsOperator('damage repaired; full walk ok');
      await until(() => status.compromised === null); // the running process learns from the database (its poll), without a restart
      expect(status.readiness()).not.toBe('contained');
      await expect(guarded.insertCapture(t.tenantId, report.uploader, captureFor(report))).resolves.toBeDefined();
    } finally {
      try {
        await monitor?.onModuleDestroy();
      } finally {
        err.mockRestore();
      }
    }
  });
});

describe('ledger watch: observing scheduled incident recording', () => {
  beforeEach(fresh, 60_000);
  afterEach(dispose);

  it('keeps the durable wait pending while PostgreSQL is blocked, then observes the committed incident', async () => {
    const t = await chain();
    const watcher = watch({ production: true, fullIntervalMs: 200, incidentPollMs: 100 });
    const holder = new Client({ connectionString: pg.adminUrl });
    let waiting: Promise<void> | undefined;
    let locked = false;
    try {
      await watcher.monitor.onApplicationBootstrap();
      await watcher.monitor.idle();
      expect(watcher.status.readiness()).toBe('up');
      await holder.connect();
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM ledger_heads WHERE tenant_id = $1 FOR UPDATE', [t.tenantId]);
      locked = true;
      await tamper((c) => c.query('UPDATE report_captures SET text_scalars = text_scalars + 1 WHERE id = $1', [t.ids.capture]));
      await until(() => watcher.status.compromised !== null);
      await untilBlocked(pg.adminUrl, 'telesphoros-ledger-verifier');
      expect(watcher.status.compromised).toMatchObject({ tenantId: t.tenantId, kind: 'payload-mismatch', source: 'scheduled' });
      expect(watcher.status.readiness()).toBe('contained');
      expect(await openIncidentTenants()).toEqual([]);
      let settled = false;
      waiting = waitForScheduledIncident(watcher, t.tenantId);
      void waiting.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      // One event-loop turn lets a local-only wait resolve; it cannot finish the locked SQL call.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      await holder.query('ROLLBACK');
      locked = false;
      await waiting;
      expect(await openIncidentTenants()).toEqual([t.tenantId]);
      const report = await seedLabReport(pg.adminUrl, t.tenantId);
      await expect(repo.insertCapture(t.tenantId, report.uploader, captureFor(report))).rejects.toBeInstanceOf(LedgerCompromisedError);
    } finally {
      if (locked) await holder.query('ROLLBACK');
      await waiting?.catch(() => undefined); // Preserve the test's original failure; the SQL recorder is released above.
      await watcher.monitor.onModuleDestroy();
      await holder.end();
    }
  });

  it('surfaces the first real recording error even after an existing sync retry succeeds', async () => {
    const t = await chain();
    const watcher = watch({ production: true, fullIntervalMs: 200, incidentPollMs: 100 });
    let revoked = false;
    try {
      await watcher.monitor.onApplicationBootstrap();
      await watcher.monitor.idle();
      expect(watcher.status.readiness()).toBe('up');
      await withAdmin(pg.adminUrl, (c) => c.query('REVOKE EXECUTE ON FUNCTION ledger_record_incident(text, text, bigint, text) FROM telesphoros_ledger_verifier'));
      revoked = true;
      await tamper((c) => c.query('UPDATE report_captures SET text_scalars = text_scalars + 1 WHERE id = $1', [t.ids.capture]));
      await until(() => watcher.verifier.incidents[0]?.outcome?.status === 'failed');
      await expect(waitForScheduledIncident(watcher, t.tenantId)).rejects.toMatchObject({ code: '42501' });
      expect(watcher.status.unrecorded()).toHaveLength(1);
      expect(watcher.status.readiness()).toBe('contained');
      expect(await openIncidentTenants()).toEqual([]);
      await withAdmin(pg.adminUrl, (c) => c.query('GRANT EXECUTE ON FUNCTION ledger_record_incident(text, text, bigint, text) TO telesphoros_ledger_verifier'));
      revoked = false;
      await until(() => watcher.verifier.incidents.some((recording) => recording.outcome?.status === 'recorded'));
      expect(await openIncidentTenants()).toEqual([t.tenantId]);
      await expect(waitForScheduledIncident(watcher, t.tenantId)).rejects.toMatchObject({ code: '42501' });
      const report = await seedLabReport(pg.adminUrl, t.tenantId);
      await expect(repo.insertCapture(t.tenantId, report.uploader, captureFor(report))).rejects.toBeInstanceOf(LedgerCompromisedError);
    } finally {
      if (revoked) await withAdmin(pg.adminUrl, (c) => c.query('GRANT EXECUTE ON FUNCTION ledger_record_incident(text, text, bigint, text) TO telesphoros_ledger_verifier'));
      await watcher.monitor.onModuleDestroy();
    }
  });
});
