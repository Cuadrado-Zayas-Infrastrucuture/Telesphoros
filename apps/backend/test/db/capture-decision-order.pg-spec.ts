import { randomUUID } from 'node:crypto';
import { Database } from '../../src/db/database';
import { PostgresLedgerRecordsRepository } from '../../src/storage/postgres/ledger-records.repository';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { acceptanceFor, captureFor, seedLabReport } from '../helpers/ledger-fixtures';

// The current decision on a capture is the one LAST IN THE LEDGER. Two reviewers deciding at once must not leave an earlier decision current.
// Synthetic data only.

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

const lastInLedger = (captureId: string) =>
  withAdmin(pg.adminUrl, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `SELECT a.id::text AS id FROM capture_acceptances a JOIN ledger_events e ON e.id = a.ledger_event_id WHERE a.capture_id = $1 ORDER BY e.seq DESC LIMIT 1`,
      [captureId],
    );
    return rows[0]?.id;
  });

// Keep all 60 races, with the default five-second deadline applied to each independent scenario.
it.each(Array.from({ length: 60 }, (_, index) => index + 1))(
  'race %i/60: reports the decision last in the ledger as current when two reviewers decide one capture at once',
  async () => {
    const report = await seedLabReport(pg.adminUrl, `tenant-${randomUUID()}`, { uploader: 'syn-up', requestedBy: 'syn-req', completedBy: 'syn-done' });
    const capture = captureFor(report);
    const captureId = (await repo.insertCapture(report.tenantId, 'syn-capturer', capture)).record.id as string;
    const settled = await Promise.allSettled([
      repo.insertAcceptance(report.tenantId, 'syn-x', acceptanceFor(captureId, capture, { decision: 'rejected' })),
      repo.insertAcceptance(report.tenantId, 'syn-y', acceptanceFor(captureId, capture)),
    ]);
    expect(settled.map((s) => s.status)).toEqual(['fulfilled', 'fulfilled']); // control: both decisions are recorded
    const expected = await lastInLedger(captureId);
    expect(expected).toBeDefined();
    expect((await repo.latestAcceptance(report.tenantId, captureId))?.id).toBe(expected);
  },
);
