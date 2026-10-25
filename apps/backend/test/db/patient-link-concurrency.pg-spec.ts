import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { Database } from '../../src/db/database';
import { PostgresLedgerRecordsRepository } from '../../src/storage/postgres/ledger-records.repository';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { acceptanceFor, captureFor, evaluationFor, type SeededReport, seedLabReport } from '../helpers/ledger-fixtures';

/**
 * A patient-link decision that repeats the newest one about the same file is a no-op. That look-up used to run before anything serialised the callers, so repeats
 * that overlapped (a client that gives up and retries while the first request is still running) each read "nothing new" and each inserted: several identical rows, and
 * an evaluation that relied on the first one was then built on a decision that was no longer the newest.
 */
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

const decision = (r: SeededReport, kind: 'verified' | 'rejected') => ({
  reportId: r.reportId,
  expectedReport: { patientId: r.patientId, sha256: r.pdfSha256, objectVersion: r.objectVersion },
  decision: kind,
  method: 'person-confirmed' as const,
  basisCode: kind === 'verified' ? 'no-identifier-on-report' : 'different-person',
});

const rows = (tenantId: string) =>
  withAdmin(pg.adminUrl, async (c: Client) => (await c.query(`SELECT count(*)::int AS n FROM report_patient_decisions WHERE tenant_id = $1`, [tenantId])).rows[0].n as number);

/** Holds the window between the look-up and the insert open, so overlapping callers overlap there every time instead of by luck. */
async function withSlowInsert<T>(work: () => Promise<T>): Promise<T> {
  await withAdmin(pg.adminUrl, async (c: Client) => {
    await c.query(`CREATE OR REPLACE FUNCTION zz_link_decision_sleep() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.4); RETURN NEW; END $$`);
    await c.query(`CREATE TRIGGER zz_link_decision_sleep BEFORE INSERT ON report_patient_decisions FOR EACH ROW EXECUTE FUNCTION zz_link_decision_sleep()`);
  });
  try {
    return await work();
  } finally {
    await withAdmin(pg.adminUrl, async (c: Client) => {
      await c.query('DROP TRIGGER zz_link_decision_sleep ON report_patient_decisions');
      await c.query('DROP FUNCTION zz_link_decision_sleep()');
    });
  }
}

describe('patient-link decisions that overlap', () => {
  it('identical decisions made at once leave one row, and all of them answer with it', async () => {
    const t = tenant();
    const report = await seedLabReport(pg.adminUrl, t);
    const results = await withSlowInsert(() => Promise.all(Array.from({ length: 4 }, () => repo.insertPatientDecision(t, 'syn-verifier', decision(report, 'rejected')))));
    expect(new Set(results.map((r) => r.record.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await rows(t)).toBe(1);
  });

  it('an evaluation that relies on that decision is accepted afterwards (it is still the newest)', async () => {
    const t = tenant();
    const report = await seedLabReport(pg.adminUrl, t);
    const capture = captureFor(report);
    const c = await repo.insertCapture(t, report.uploader, capture);
    const a = await repo.insertAcceptance(t, 'syn-reviewer', acceptanceFor(c.record.id, capture));
    const results = await withSlowInsert(() => Promise.all(Array.from({ length: 4 }, () => repo.insertPatientDecision(t, 'syn-verifier', decision(report, 'verified')))));
    const relied = results[0]!.record.id;
    const evaluation = await repo.insertEvaluation(t, 'syn-system', evaluationFor(report, c.record.id, a.record.id, { patientLinkDecisionId: relied }));
    expect(evaluation.created).toBe(true);
  });

  it('control: different decisions made at once are all recorded, in some order (the lock serialises them, it does not swallow a change)', async () => {
    const t = tenant();
    const report = await seedLabReport(pg.adminUrl, t);
    const results = await withSlowInsert(() =>
      Promise.all([repo.insertPatientDecision(t, 'syn-verifier', decision(report, 'verified')), repo.insertPatientDecision(t, 'syn-other', decision(report, 'rejected'))]),
    );
    expect(results.every((r) => r.created)).toBe(true);
    expect(await rows(t)).toBe(2);
    expect(results.map((r) => r.record.id)).toContain((await repo.latestPatientDecision(t, report.reportId))?.id);
  });

  it('control: another report is not held up by this one (the lock is per report)', async () => {
    const t = tenant();
    const one = await seedLabReport(pg.adminUrl, t);
    const two = await seedLabReport(pg.adminUrl, t);
    const results = await withSlowInsert(() =>
      Promise.all([repo.insertPatientDecision(t, 'syn-verifier', decision(one, 'rejected')), repo.insertPatientDecision(t, 'syn-verifier', decision(two, 'rejected'))]),
    );
    expect(results.every((r) => r.created)).toBe(true);
    expect(await rows(t)).toBe(2);
  });
});
