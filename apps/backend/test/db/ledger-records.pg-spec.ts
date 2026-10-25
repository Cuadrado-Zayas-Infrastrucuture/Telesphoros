import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { Database } from '../../src/db/database';
import { LedgerIntegrityError } from '../../src/ledger/ledger-types';
import { PostgresLedgerRecordsRepository } from '../../src/storage/postgres/ledger-records.repository';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { acceptanceFor, captureFor, evaluationFor, type SeededReport, seedLabReport } from '../helpers/ledger-fixtures';

let pg: EphemeralDatabase;
let database: Database;
let repo: PostgresLedgerRecordsRepository;
const tenant = () => `tenant-${randomUUID()}`;

beforeAll(async () => {
  pg = await createEphemeralDatabase();
  database = new Database({ url: pg.appUrl, ssl: 'disable' });
  repo = new PostgresLedgerRecordsRepository(database);
});
afterAll(async () => {
  await database.onModuleDestroy();
  await pg.drop();
});

const events = (tenantId: string) =>
  withAdmin(
    pg.adminUrl,
    async (c: Client) =>
      (await c.query(`SELECT seq::int AS seq, event_type, subject_table, actor_sub, prev_hash, record_hash FROM ledger_events WHERE tenant_id = $1 ORDER BY seq`, [tenantId])).rows,
  );

async function pipeline(report: SeededReport) {
  const capture = captureFor(report);
  const c = await repo.insertCapture(report.tenantId, report.uploader, capture);
  const a = await repo.insertAcceptance(report.tenantId, 'syn-reviewer', acceptanceFor(c.record.id, capture, { note: 'looks right' }));
  const e = await repo.insertEvaluation(report.tenantId, 'syn-system', evaluationFor(report, c.record.id, a.record.id));
  return { capture, c, a, e };
}

describe('ledger records: the happy path', () => {
  it('stores capture, acceptance and evaluation, each with a chained ledger event', async () => {
    const t = tenant();
    const report = await seedLabReport(pg.adminUrl, t);
    const { c, a, e } = await pipeline(report);
    expect([c.created, a.created, e.created]).toEqual([true, true, true]);
    const list = await events(t);
    expect(list.map((x) => [x.seq, x.event_type, x.subject_table])).toEqual([
      [1, 'capture', 'report_captures'],
      [2, 'capture-decision', 'capture_acceptances'],
      [3, 'evaluation', 'evaluations'],
    ]);
    expect(list[0]!.prev_hash).toBe('0'.repeat(64));
    expect(list[1]!.prev_hash).toBe(list[0]!.record_hash);
    expect(list[2]!.prev_hash).toBe(list[1]!.record_hash);
    expect(list.map((x) => x.actor_sub)).toEqual([report.uploader, 'syn-reviewer', 'syn-system']);
  });

  it('returns the projection that was hashed, with free text replaced by its digest', async () => {
    const t = tenant();
    const report = await seedLabReport(pg.adminUrl, t);
    const { a, e } = await pipeline(report);
    expect(a.record.note).toEqual({ id: expect.any(String), bodySha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(JSON.stringify(a.record)).not.toContain('looks right');
    expect(await repo.findEvaluation(t, e.record.id)).toEqual(e.record);
    expect((e.record.results as unknown[]).length).toBe(3);
    expect((e.record.geneStates as unknown[]).length).toBe(2);
  });

  it('is idempotent: the same capture and the same evaluation return the existing record', async () => {
    const t = tenant();
    const report = await seedLabReport(pg.adminUrl, t);
    const { capture, c, a, e } = await pipeline(report);
    const again = await repo.insertCapture(t, report.uploader, { ...capture, textStorageKey: `text/${randomUUID()}` });
    expect(again.created).toBe(false);
    expect(again.record.id).toBe(c.record.id);
    const evAgain = await repo.insertEvaluation(t, 'syn-system', evaluationFor(report, c.record.id, a.record.id));
    expect(evAgain.created).toBe(false);
    expect(evAgain.record.id).toBe(e.record.id);
    expect((await events(t)).length).toBe(3);
  });

  it('refuses an acceptance by the person who uploaded the report', async () => {
    const t = tenant();
    const report = await seedLabReport(pg.adminUrl, t);
    const capture = captureFor(report);
    const c = await repo.insertCapture(t, report.uploader, capture);
    await expect(repo.insertAcceptance(t, report.uploader, acceptanceFor(c.record.id, capture))).rejects.toBeInstanceOf(LedgerIntegrityError);
    expect((await events(t)).length).toBe(1); // nothing of the refused write remains
  });
});
