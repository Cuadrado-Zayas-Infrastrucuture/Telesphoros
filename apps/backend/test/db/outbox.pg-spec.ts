import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { Database } from '../../src/db/database';
import { PostgresPatientsRepository } from '../../src/storage/postgres/patients.repository';
import { PostgresReportsRepository } from '../../src/storage/postgres/reports.repository';
import type { ReportRecord } from '../../src/storage/records';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { commitUpload, declareUpload } from '../helpers/uploads';

// M2.3b: the upload commit writes its follow-up event INSIDE its own transaction, and the migration seeds the route and the schedules the consumers rely on.
let db: EphemeralDatabase;
let database: Database;
let reports: PostgresReportsRepository;
let patients: PostgresPatientsRepository;
const HASH = 'a'.repeat(64);

beforeAll(async () => {
  db = await createEphemeralDatabase();
  database = new Database({ url: db.appUrl, ssl: 'disable' });
  reports = new PostgresReportsRepository(database);
  patients = new PostgresPatientsRepository(database);
});
afterAll(async () => {
  await database?.onModuleDestroy();
  await db?.drop();
});

const owner = <T>(work: (c: Client) => Promise<T>) => withAdmin(db.adminUrl, work);
const tenant = () => `syn-outbox-${randomUUID().slice(0, 8)}`;
async function newReport(tenantId: string): Promise<ReportRecord> {
  const now = new Date().toISOString();
  const p = { id: randomUUID(), tenantId, createdBy: 'syn-actor', label: `SYN-${randomUUID().slice(0, 8)}`, createdAt: now, updatedAt: now };
  await patients.insert(p);
  const r: ReportRecord = {
    id: randomUUID(),
    tenantId,
    createdBy: 'syn-actor',
    patientId: p.id,
    type: 'structured',
    filename: 'a.json',
    sizeBytes: 1000,
    status: 'received',
    storageKey: null,
    contentType: null,
    sha256: null,
    uploadedAt: null,
    objectVersion: null,
    uploadRequestedBy: null,
    uploadedBy: null,
    createdAt: now,
    updatedAt: now,
  };
  await reports.insert(r);
  return r;
}
const eventsFor = (reportId: string) =>
  owner(async (c) => (await c.query('SELECT tenant_id, event_type, subject_id, relayed_at FROM outbox_events WHERE subject_id = $1', [reportId])).rows);

describe('the upload commit and the outbox', () => {
  it("writes exactly one event when the commit pins the file, for the report's organization, and not a second when the commit is repeated", async () => {
    const t = tenant();
    const r = await newReport(t);
    expect(await eventsFor(r.id)).toEqual([]);
    const h = await commitUpload(reports, r, { principal: 'p', sha256: HASH, contentType: 'application/json', version: 'v1' });
    expect(await eventsFor(r.id)).toEqual([{ tenant_id: t, event_type: 'report.file-committed', subject_id: r.id, relayed_at: null }]);
    expect(await reports.commitAttempt(h.identity)).toBe(true); // an idempotent repeat
    expect(await eventsFor(r.id)).toHaveLength(1);
  });

  it('writes none for a declaration, a refused commit or a cancelled attempt', async () => {
    const t = tenant();
    const [declared, cancelled] = [await newReport(t), await newReport(t)];
    await declareUpload(reports, declared, { principal: 'p', sha256: HASH, contentType: 'application/json' });
    const h = (await declareUpload(reports, cancelled, { principal: 'p', sha256: HASH, contentType: 'application/json' }))!;
    await reports.cancelAttempt(h.identity);
    expect(await reports.commitAttempt(h.identity)).toBe(false);
    expect(await eventsFor(declared.id)).toEqual([]);
    expect(await eventsFor(cancelled.id)).toEqual([]);
  });

  it('leaves no event when the transaction that holds the commit is rolled back', async () => {
    const t = tenant();
    const id = randomUUID();
    await expect(
      database.withTenant(t, async (c) => {
        await c.query('SELECT outbox_append($1, $2)', ['report.file-committed', id]);
        throw new Error('the rest of the commit failed');
      }),
    ).rejects.toThrow('the rest of the commit failed');
    expect(await eventsFor(id)).toEqual([]);
  });
});

describe('what the migration seeds', () => {
  it('routes a committed file to its re-check and schedules the hourly sweep and the daily integrity re-check', async () => {
    expect((await owner((c) => c.query('SELECT event_type, job_type, subject_key, max_attempts FROM outbox_routes'))).rows).toEqual([
      { event_type: 'report.file-committed', job_type: 'files.verify-stored', subject_key: 'reportId', max_attempts: 5 },
    ]);
    expect((await owner((c) => c.query('SELECT type, interval_seconds, max_attempts, enabled FROM job_schedules ORDER BY type'))).rows).toEqual([
      { type: 'files.verify-stale', interval_seconds: 86400, max_attempts: 3, enabled: true },
      { type: 'uploads.sweep', interval_seconds: 3600, max_attempts: 5, enabled: true },
    ]);
  });
});
