import { randomUUID } from 'node:crypto';
import { Database } from '../../src/db/database';
import { PostgresLedgerRecordsRepository } from '../../src/storage/postgres/ledger-records.repository';
import { PostgresUsageRepository } from '../../src/storage/postgres/usage.repository';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { acceptanceFor, captureFor, evaluationFor, seedLabReport, sha } from '../helpers/ledger-fixtures';

// Usage counts (specs/010-usage) against a REAL database, read through the APPLICATION role: row-level security is part of what is tested.
// Rows are written as the administrator so each can carry a chosen upload time. Synthetic data only.

let pg: EphemeralDatabase;
let database: Database;
let usage: PostgresUsageRepository;
let ledger: PostgresLedgerRecordsRepository;

const FROM = new Date('2026-10-01T04:00:00Z');
const TO = new Date('2026-11-01T04:00:00Z');
const at = (iso: string) => new Date(iso);

/** A report row for `tenant`, uploaded at `uploadedAt` (or never), optionally deleted since. */
async function report(tenant: string, sizeBytes: number, uploadedAt: Date | null, deleted = false): Promise<void> {
  const id = randomUUID();
  const patientId = randomUUID();
  await withAdmin(pg.adminUrl, async (c) => {
    await c.query(`INSERT INTO tenants (id, display_name, created_by, changed_by) VALUES ($1, $1, 'test-usage', 'test-usage') ON CONFLICT (id) DO NOTHING`, [tenant]);
    await c.query(`INSERT INTO patients (id, tenant_id, created_by, label) VALUES ($1, $2, 'syn-uploader', $3)`, [patientId, tenant, `SYN-${id.slice(0, 8)}`]);
    const uploaded = uploadedAt !== null;
    await c.query(
      `INSERT INTO reports (id, tenant_id, created_by, patient_id, type, original_filename, size_bytes, status, content_type, sha256, storage_key, uploaded_at,
                            object_version, upload_requested_by, uploaded_by)
       VALUES ($1, $2, 'syn-uploader', $3, 'lab-pdf', 'syn.pdf', $4, 'received', $5, $6, $7, $8, $9, $10, $10)`,
      [
        id,
        tenant,
        patientId,
        sizeBytes,
        uploaded ? 'application/pdf' : null,
        uploaded ? sha(`pdf:${id}`) : null,
        uploaded ? `k/${id}` : null,
        uploadedAt,
        uploaded ? `syn-version-${id.slice(0, 8)}` : null,
        uploaded ? 'syn-uploader' : null,
      ],
    );
    if (deleted) await c.query('UPDATE reports SET deleted_at = now() WHERE id = $1', [id]);
  });
}

beforeAll(async () => {
  pg = await createEphemeralDatabase();
  database = new Database({ url: pg.appUrl, ssl: 'disable' });
  usage = new PostgresUsageRepository(database);
  ledger = new PostgresLedgerRecordsRepository(database);
});
afterAll(async () => {
  await database.onModuleDestroy();
  await pg.drop();
});

describe('PostgresUsageRepository', () => {
  it('counts uploads inside [from, to) only, keeps deleted reports as uploads, and never counts a report that was not uploaded', async () => {
    const tenant = `tenant-${randomUUID()}`;
    await report(tenant, 100, at('2026-10-01T04:00:00Z')); // first instant: in
    await report(tenant, 200, at('2026-10-31T23:00:00Z')); // in
    await report(tenant, 300, at('2026-11-01T03:59:59Z'), true); // last second, deleted since: in
    await report(tenant, 400, at('2026-10-01T03:59:59Z')); // September in Puerto Rico: out
    await report(tenant, 500, at('2026-11-01T04:00:00Z')); // November: out
    await report(tenant, 600, null); // never uploaded: nowhere
    expect(await usage.activity(tenant, FROM, TO)).toEqual({ reportsUploaded: 3, evaluated: 0, held: 0 });
    expect(await usage.storage(tenant)).toEqual({ reportFiles: 4, reportBytes: 100 + 200 + 400 + 500 });
  });

  it("never counts another organization's reports or storage", async () => {
    const mine = `tenant-${randomUUID()}`;
    const theirs = `tenant-${randomUUID()}`;
    await report(mine, 10, at('2026-10-10T12:00:00Z'));
    await report(theirs, 9000, at('2026-10-10T12:00:00Z'));
    await report(theirs, 9000, at('2026-10-11T12:00:00Z'));
    expect(await usage.activity(mine, FROM, TO)).toEqual({ reportsUploaded: 1, evaluated: 0, held: 0 });
    expect(await usage.storage(mine)).toEqual({ reportFiles: 1, reportBytes: 10 });
  });

  it('counts a real evaluation in the window it was recorded in, for its own organization only', async () => {
    const tenant = `tenant-${randomUUID()}`;
    const seeded = await seedLabReport(pg.adminUrl, tenant);
    const capture = captureFor(seeded);
    const c = await ledger.insertCapture(tenant, seeded.uploader, capture);
    const a = await ledger.insertAcceptance(tenant, 'syn-reviewer', acceptanceFor(c.record.id, capture));
    await ledger.insertEvaluation(tenant, 'syn-system', evaluationFor(seeded, c.record.id, a.record.id));
    const around = [new Date(Date.now() - 3_600_000), new Date(Date.now() + 3_600_000)] as const;
    expect(await usage.activity(tenant, ...around)).toEqual({ reportsUploaded: 1, evaluated: 1, held: 0 });
    expect(await usage.activity(tenant, new Date(Date.now() - 7_200_000), around[0])).toEqual({ reportsUploaded: 0, evaluated: 0, held: 0 });
    expect(await usage.activity(`tenant-${randomUUID()}`, ...around)).toEqual({ reportsUploaded: 0, evaluated: 0, held: 0 });
  });
});

describe('PostgresUsageRepository, per Puerto Rico day (specs/028-usage-heatmap)', () => {
  const YEAR_FROM = new Date('2026-01-01T04:00:00Z');
  const YEAR_TO = new Date('2027-01-01T04:00:00Z');

  it('groups uploads by Puerto Rico day at the 04:00 UTC edge, keeps deleted reports, and lists only days with uploads', async () => {
    const tenant = `tenant-${randomUUID()}`;
    await report(tenant, 1, at('2026-01-01T03:59:59Z')); // 31 December 2025 in Puerto Rico: outside the year
    await report(tenant, 1, at('2026-01-01T04:00:00Z')); // first instant of 2026
    await report(tenant, 1, at('2026-10-31T03:59:59Z')); // 30 October
    await report(tenant, 1, at('2026-10-31T04:00:00Z')); // 31 October
    await report(tenant, 1, at('2026-10-31T23:00:00Z'), true); // 31 October, deleted since: still an upload
    await report(tenant, 1, at('2027-01-01T03:59:59Z')); // last second of 2026
    await report(tenant, 1, at('2027-01-01T04:00:00Z')); // 2027: outside
    await report(tenant, 1, null); // never uploaded: nowhere
    expect(await usage.uploadsByDay(tenant, YEAR_FROM, YEAR_TO)).toEqual([
      { date: '2026-01-01', reportsUploaded: 1 },
      { date: '2026-10-30', reportsUploaded: 1 },
      { date: '2026-10-31', reportsUploaded: 2 },
      { date: '2026-12-31', reportsUploaded: 1 },
    ]);
  });

  it("never counts another organization's uploads", async () => {
    const mine = `tenant-${randomUUID()}`;
    const theirs = `tenant-${randomUUID()}`;
    await report(mine, 1, at('2026-05-14T12:00:00Z'));
    await report(theirs, 1, at('2026-05-14T12:00:00Z'));
    await report(theirs, 1, at('2026-05-15T12:00:00Z'));
    expect(await usage.uploadsByDay(mine, YEAR_FROM, YEAR_TO)).toEqual([{ date: '2026-05-14', reportsUploaded: 1 }]);
    expect(await usage.uploadsByDay(`tenant-${randomUUID()}`, YEAR_FROM, YEAR_TO)).toEqual([]);
  });

  it("reads the caller's own organization's creation time", async () => {
    const tenant = `tenant-${randomUUID()}`;
    await withAdmin(pg.adminUrl, (c) =>
      c.query(`INSERT INTO tenants (id, display_name, created_by, changed_by, created_at) VALUES ($1, $1, 'test-usage', 'test-usage', $2)`, [tenant, at('2025-03-09T02:00:00Z')]),
    );
    expect((await usage.createdAt(tenant)).toISOString()).toBe('2025-03-09T02:00:00.000Z');
  });
});
