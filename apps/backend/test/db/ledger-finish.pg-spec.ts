import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { Database } from '../../src/db/database';
import { loadProjections } from '../../src/ledger/projections';
import type { RecordTable } from '../../src/ledger/ledger-types';
import { PostgresLedgerRecordsRepository } from '../../src/storage/postgres/ledger-records.repository';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { acceptanceFor, captureFor, evaluationFor, seedLabReport, sha } from '../helpers/ledger-fixtures';

// What `finish` hands back after it appends the event. The record returned must be exactly what a reader sees once the transaction has committed,
// and the statements that run while the tenant's ledger lock is held (from the first append to COMMIT) must not include a second load of a record
// whose projection the append has just read, hashed and stored.
let pg: EphemeralDatabase;
let database: Database;
let repo: PostgresLedgerRecordsRepository;
beforeAll(async () => {
  pg = await createEphemeralDatabase();
  database = new Database({ url: pg.appUrl, ssl: 'disable' });
  repo = new PostgresLedgerRecordsRepository(database);
});
afterAll(async () => {
  await database.onModuleDestroy();
  await pg.drop();
});

const tenant = () => `tenant-${randomUUID()}`;
const reread = (table: RecordTable, id: string) => withAdmin(pg.adminUrl, async (c) => (await loadProjections(c, table, [id])).get(id));

/** Statements run in the transaction after its first `ledger_append`, up to and including COMMIT, for each transaction `work` opens. */
async function lockWindow<T>(work: () => Promise<T>): Promise<{ value: T; windows: number[] }> {
  const original = Client.prototype.query as unknown as (...a: unknown[]) => unknown;
  const windows: number[] = [];
  const spy = jest.spyOn(Client.prototype, 'query').mockImplementation(function (this: { __w?: { n: number; at: number | null } }, ...args: unknown[]) {
    const first = args[0];
    const sql = typeof first === 'string' ? first : ((first as { text?: string } | undefined)?.text ?? '');
    const state = (this.__w ??= { n: 0, at: null });
    if (sql === 'BEGIN') Object.assign(state, { n: 0, at: null });
    state.n += 1;
    if (sql.includes('ledger_append(') && state.at === null) state.at = state.n;
    if (sql === 'COMMIT' && state.at !== null) windows.push(state.n - state.at);
    return original.apply(this, args);
  } as never);
  try {
    return { value: await work(), windows };
  } finally {
    spy.mockRestore();
  }
}

describe('what a write hands back', () => {
  it('is exactly what a reader sees after the commit, for every record the repository appends and returns', async () => {
    const t = tenant();
    const seeded = await seedLabReport(pg.adminUrl, t);
    const input = captureFor(seeded);
    const capture = await repo.insertCapture(t, seeded.uploader, input);
    const acceptance = await repo.insertAcceptance(t, 'syn-reviewer', acceptanceFor(capture.record.id, input));
    const evaluation = await repo.insertEvaluation(t, 'syn-system', evaluationFor(seeded, capture.record.id, acceptance.record.id));
    const correction = await repo.insertCorrection(t, 'syn-reviewer', { evaluationId: evaluation.record.id, kind: 'retraction', reasonCode: 'software-defect' });
    const dispute = await repo.raiseDispute(t, 'syn-reviewer', {
      guidelineId: 'syn-advisory',
      guidelineVersion: '1',
      guidelineContentSha256: sha('advisory'),
      locator: { table: '1', row: '1' },
      note: 'Synthetic evidence',
    });
    const decision = await repo.decideDispute(t, 'syn-decider', { disputeId: dispute.record.id, decision: 'dismissed', evidenceNote: 'the cell is right' });
    const stored: [RecordTable, { record: { id: string }; created: boolean }][] = [
      ['report_captures', capture],
      ['capture_acceptances', acceptance],
      ['evaluations', evaluation],
      ['corrections', correction],
      ['cell_disputes', dispute],
      ['cell_dispute_decisions', decision],
    ];
    for (const [table, result] of stored) {
      expect(result.created).toBe(true);
      expect(await reread(table, result.record.id)).toEqual(result.record);
    }
  });
});

describe('the ledger lock window', () => {
  it('holds no second load of a record the append has just read: a write ends with its COMMIT, not a reload', async () => {
    const t = tenant();
    const seeded = await seedLabReport(pg.adminUrl, t);
    const input = captureFor(seeded);
    const capture = await lockWindow(() => repo.insertCapture(t, seeded.uploader, input));
    const acceptance = await lockWindow(() => repo.insertAcceptance(t, 'syn-reviewer', acceptanceFor(capture.value.record.id, input)));
    const evaluation = await lockWindow(() => repo.insertEvaluation(t, 'syn-system', evaluationFor(seeded, capture.value.record.id, acceptance.value.record.id)));
    const correction = await lockWindow(() =>
      repo.insertCorrection(t, 'syn-reviewer', { evaluationId: evaluation.value.record.id, kind: 'retraction', reasonCode: 'software-defect' }),
    );
    const dispute = await lockWindow(() =>
      repo.raiseDispute(t, 'syn-reviewer', {
        guidelineId: 'syn-advisory',
        guidelineVersion: '1',
        guidelineContentSha256: sha('advisory'),
        locator: { table: '1', row: '1' },
        note: 'Synthetic evidence',
      }),
    );
    // Only the COMMIT is left after the append for a record with nothing to re-check; the evaluation also re-checks its acceptance, link and disputes.
    expect(acceptance.windows).toEqual([1]);
    expect(correction.windows).toEqual([1]);
    expect(dispute.windows).toEqual([1]);
    expect(evaluation.windows).toHaveLength(1);
    expect(evaluation.windows[0]).toBeLessThanOrEqual(6);
    expect(capture.windows).toHaveLength(1);
    expect(capture.windows[0]).toBeLessThanOrEqual(CAPTURE_WINDOW);
  });
});

const CAPTURE_WINDOW = 4; // the capture and its provenance record are appended; neither is loaded again
