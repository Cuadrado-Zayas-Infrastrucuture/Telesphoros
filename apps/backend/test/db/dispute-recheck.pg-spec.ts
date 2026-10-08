import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { Database } from '../../src/db/database';
import { DisputeActiveError } from '../../src/ledger/ledger-types';
import { PostgresLedgerRecordsRepository } from '../../src/storage/postgres/ledger-records.repository';
import { Session, untilBlocked } from '../helpers/barrier';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { acceptanceFor, captureFor, evaluationFor, seedLabReport } from '../helpers/ledger-fixtures';

// The dispute re-check (plan 12.2). An evaluation that shows drug results must not be stored while a dispute is open or upheld.
// The check is only conclusive because it runs AFTER the tenant's ledger lock is held, as its own statement. The orders below are
// decided by the database's lock queue, not by sleeping.
let pg: EphemeralDatabase;
let database: Database;
let repo: PostgresLedgerRecordsRepository;
let gated: PostgresLedgerRecordsRepository;

/** A Database that can hold a transaction open after its work is done and before it COMMITs, so a test can decide the ledger lock's order. */
class PausableDatabase extends Database {
  pause?: { reached: () => void; release: Promise<void> };
  override async withTenant<T>(tenantId: string, work: (client: PoolClient) => Promise<T>, options?: { actor?: string }): Promise<T> {
    return super.withTenant(tenantId, async (client) => {
      const result = await work(client);
      const pause = this.pause;
      if (pause) {
        this.pause = undefined; // only the first transaction after the test asks for it
        pause.reached();
        await pause.release;
      }
      return result;
    }, options);
  }
}
let pausable: PausableDatabase;
function pausedBeforeCommit(db: PausableDatabase) {
  let release!: () => void;
  let reached!: () => void;
  const reachedPromise = new Promise<void>((resolve) => (reached = resolve));
  db.pause = { reached, release: new Promise<void>((resolve) => (release = resolve)) };
  return { reached: reachedPromise, release: () => release() };
}
const WRITER = 'eval-writer';
const tenant = () => `tenant-${randomUUID()}`;

beforeAll(async () => {
  pg = await createEphemeralDatabase();
  database = new Database({ url: pg.appUrl, ssl: 'disable', applicationName: WRITER });
  repo = new PostgresLedgerRecordsRepository(database);
  pausable = new PausableDatabase({ url: pg.appUrl, ssl: 'disable', applicationName: 'eval-paused' });
  gated = new PostgresLedgerRecordsRepository(pausable);
});
afterAll(async () => {
  await pausable.onModuleDestroy();
  await database.onModuleDestroy();
  await pg.drop();
});

/** A report, an accepted capture, and the inputs for an evaluation of it. */
async function ready(t = tenant()) {
  const report = await seedLabReport(pg.adminUrl, t);
  const capture = captureFor(report);
  const c = await repo.insertCapture(t, report.uploader, capture);
  const a = await repo.insertAcceptance(t, 'syn-reviewer', acceptanceFor(c.record.id, capture));
  return { t, report, evaluation: (over = {}) => evaluationFor(report, c.record.id, a.record.id, over) };
}
const count = (sql: string, values: unknown[]) => withAdmin(pg.adminUrl, async (c) => (await c.query(sql, values)).rows[0].n as number);
const evaluations = (t: string) => count(`SELECT count(*)::int AS n FROM evaluations WHERE tenant_id = $1`, [t]);
const evaluationEvents = (t: string) => count(`SELECT count(*)::int AS n FROM ledger_events WHERE tenant_id = $1 AND event_type = 'evaluation'`, [t]);
const sessions: Session[] = [];
const open = async (name: string, t: string, actor: string) => {
  const s = await Session.open(pg.appUrl, `${name}-${randomUUID().slice(0, 6)}`, t, actor);
  sessions.push(s);
  return s;
};
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});
const settle = <T>(work: Promise<T>) => work.then((value) => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }));
const dispute = { guidelineId: 'syn-guideline', guidelineVersion: '1', guidelineContentSha256: 'c'.repeat(64), locator: { table: 'recommendations', row: 'poor' }, note: 'a disputed cell' };

describe('a dispute and an evaluation racing for the same tenant (decided by the ledger lock queue)', () => {
  it('dispute commits first: the evaluation is refused, and nothing of it remains (no row, no event)', async () => {
    const { t, evaluation } = await ready();
    const other = await ready(); // control: another tenant has its own lock and is not held up
    const disputer = await open('dispute', t, 'syn-disputer');
    await disputer.raiseDispute(t); // uncommitted: holds this tenant's ledger lock

    const pending = settle(repo.insertEvaluation(t, 'syn-system', evaluation()));
    await untilBlocked(pg.adminUrl, WRITER);
    expect((await repo.insertEvaluation(other.t, 'syn-system', other.evaluation())).created).toBe(true); // control

    await disputer.commit();
    const { error } = await pending;
    expect(error).toBeInstanceOf(DisputeActiveError);
    expect(await evaluations(t)).toBe(0);
    expect(await evaluationEvents(t)).toBe(0);
    expect(await repo.activeDisputeExists(t)).toBe(true);
  });

  it('evaluation first: it is stored, the later dispute waits behind it and commits after it, and the dispute is then active', async () => {
    const { t, evaluation } = await ready();
    const disputer = await open('dispute', t, 'syn-disputer');
    const prepared = await disputer.prepareDispute(t); // everything that does not need the lock is done first

    // The REAL evaluation code runs, and is paused just before COMMIT, after its append and its dispute re-check: it holds the ledger lock.
    // (Two waiters on one lock are not served in a guaranteed order, so the evaluation is made the holder instead of racing for the queue.)
    const gate = pausedBeforeCommit(pausable);
    const evaluating = settle(gated.insertEvaluation(t, 'syn-system', evaluation()));
    await gate.reached;
    const raising = settle(disputer.appendPrepared(prepared));
    await untilBlocked(pg.adminUrl, disputer.name); // the dispute is queued behind the evaluation
    gate.release();

    const stored = await evaluating;
    expect(stored.error).toBeUndefined();
    expect(stored.value!.created).toBe(true);
    expect((await raising).error).toBeUndefined();
    await disputer.commit();

    expect(await evaluations(t)).toBe(1);
    expect(await repo.activeDisputeExists(t)).toBe(true);
    const events = await withAdmin(pg.adminUrl, async (c) => (await c.query(`SELECT event_type FROM ledger_events WHERE tenant_id = $1 ORDER BY seq`, [t])).rows.map((r) => r.event_type));
    expect(events.slice(-2)).toEqual(['evaluation', 'dispute']); // the dispute is ordered AFTER the evaluation it could not have been known to
  });

  it('the same replay of a stored evaluation still returns it while a dispute is active (the check is for new results only)', async () => {
    const { t, evaluation } = await ready();
    const first = await repo.insertEvaluation(t, 'syn-system', evaluation());
    await repo.raiseDispute(t, 'syn-disputer', dispute);
    const again = await repo.insertEvaluation(t, 'syn-system', evaluation());
    expect(again.created).toBe(false);
    expect(again.record.id).toBe(first.record.id);
  });
});

describe('which disputes block', () => {
  it('open and upheld ones do; a dismissed one does not (and the control: no dispute at all)', async () => {
    const control = await ready();
    expect((await repo.insertEvaluation(control.t, 'syn-system', control.evaluation())).created).toBe(true);

    const open = await ready();
    await repo.raiseDispute(open.t, 'syn-disputer', dispute);
    expect(await repo.activeDisputeExists(open.t)).toBe(true);
    await expect(repo.insertEvaluation(open.t, 'syn-system', open.evaluation())).rejects.toBeInstanceOf(DisputeActiveError);

    const upheld = await ready();
    const u = await repo.raiseDispute(upheld.t, 'syn-disputer', dispute);
    await repo.decideDispute(upheld.t, 'syn-decider', { disputeId: u.record.id, decision: 'upheld', evidenceNote: 'the cell is wrong' });
    expect(await repo.activeDisputeExists(upheld.t)).toBe(true);
    await expect(repo.insertEvaluation(upheld.t, 'syn-system', upheld.evaluation())).rejects.toBeInstanceOf(DisputeActiveError);

    const dismissed = await ready();
    const d = await repo.raiseDispute(dismissed.t, 'syn-disputer', dispute);
    await repo.decideDispute(dismissed.t, 'syn-decider', { disputeId: d.record.id, decision: 'dismissed', evidenceNote: 'the cell is right' });
    expect(await repo.activeDisputeExists(dismissed.t)).toBe(false);
    expect((await repo.insertEvaluation(dismissed.t, 'syn-system', dismissed.evaluation())).created).toBe(true);
  });

  it('a held evaluation shows no drug result and is not blocked by a dispute', async () => {
    const { t, evaluation } = await ready();
    await repo.raiseDispute(t, 'syn-disputer', dispute);
    const held = await repo.insertEvaluation(t, 'syn-system', evaluation({ disposition: 'held', holdCode: 'unsupported-layout', geneInputs: [], occurrences: [], results: [], geneStates: [] }));
    expect(held.created).toBe(true);
    expect(held.record.disposition).toBe('held');
  });
});

describe('why the check is sound, asserted rather than assumed', () => {
  it('runs under READ COMMITTED, so a statement issued after the lock takes a fresh snapshot', async () => {
    const level = await database.withTenant(tenant(), async (client) => (await client.query(`SHOW transaction_isolation`)).rows[0].transaction_isolation as string, { actor: 'syn' });
    expect(level).toBe('read committed');
  });

  it('every dispute change appends a ledger event, so it needs the same lock as an evaluation', async () => {
    const { t } = await ready();
    const before = await count(`SELECT count(*)::int AS n FROM ledger_events WHERE tenant_id = $1`, [t]);
    const raised = await repo.raiseDispute(t, 'syn-disputer', dispute);
    await repo.decideDispute(t, 'syn-decider', { disputeId: raised.record.id, decision: 'dismissed', evidenceNote: 'fine' });
    expect(await count(`SELECT count(*)::int AS n FROM ledger_events WHERE tenant_id = $1`, [t])).toBe(before + 2);
  });

  it('raising and deciding a dispute each wait behind a held ledger lock (they cannot slip past an evaluation)', async () => {
    const { t } = await ready();
    const elsewhere = await seedLabReport(pg.adminUrl, t, { label: 'SYN-HOLD2' });
    const holder = await open('holder', t, 'syn-holder');
    await holder.insertCapture(elsewhere);
    const raising = settle(repo.raiseDispute(t, 'syn-disputer', dispute));
    await untilBlocked(pg.adminUrl, WRITER);
    await holder.commit();
    expect((await raising).error).toBeUndefined();
  });

  it('is a separate statement after the append: the source keeps the check out of the statement that appends, and after it', () => {
    const source = readFileSync(join(__dirname, '../../src/storage/postgres/ledger-records.repository.ts'), 'utf8');
    const insertEvaluation = source.slice(source.indexOf('insertEvaluation(tenantId'), source.indexOf('activeDisputeExists(tenantId'));
    const finishAt = insertEvaluation.indexOf('await this.finish(client, tenantId, \'evaluations\'');
    const checkAt = insertEvaluation.indexOf('await this.assertNoActiveDispute(');
    expect(finishAt).toBeGreaterThan(0);
    expect(checkAt).toBeGreaterThan(finishAt); // the check comes after the append, never before it
    const checkSql = source.slice(source.indexOf('private async hasActiveDispute'), source.indexOf('/** Its own statement'));
    expect(checkSql).toContain('cell_disputes');
    expect(checkSql).not.toContain('ledger_append'); // not folded into the append
    expect(source.slice(source.indexOf('private async finish'), source.indexOf('private async eventIdOf'))).not.toContain('Dispute');
  });
});
