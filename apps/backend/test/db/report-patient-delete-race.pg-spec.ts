import { randomUUID } from 'node:crypto';
import type { Client, PoolClient } from 'pg';
import { Database } from '../../src/db/database';
import { IntegrityError } from '../../src/storage/errors';
import { PostgresPatientsRepository } from '../../src/storage/postgres/patients.repository';
import { PostgresReportsRepository } from '../../src/storage/postgres/reports.repository';
import type { ReportRecord } from '../../src/storage/records';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';

/**
 * Registering a report while its patient is being deleted. The service reads the patient in one transaction and inserts the report in another, and the
 * patient's soft-delete trigger asks "are there live reports?" under READ COMMITTED, so it cannot see a report that has not committed. The report's foreign key
 * takes only a KEY SHARE lock, which a soft delete (an update that does not touch the key) does not conflict with. Without a lock the two could both commit
 * and leave a live report on a deleted patient. Each test pins one interleaving with a gate placed just before the commit.
 */
let pg: EphemeralDatabase;
let database: Database;
let reports: PostgresReportsRepository;
let patients: PostgresPatientsRepository;
beforeAll(async () => {
  pg = await createEphemeralDatabase();
  database = new Database({ url: pg.appUrl, ssl: 'disable' });
  reports = new PostgresReportsRepository(database);
  patients = new PostgresPatientsRepository(database);
});
afterAll(async () => {
  await database?.onModuleDestroy();
  await pg?.drop();
});
afterEach(() => jest.restoreAllMocks());

const tenant = () => `tenant-${randomUUID().slice(0, 8)}`;
const owner = <T>(work: (c: Client) => Promise<T>) => withAdmin(pg.adminUrl, work);
async function patient(t: string): Promise<string> {
  const id = randomUUID();
  await owner((c) => c.query(`INSERT INTO patients (id, tenant_id, created_by, label) VALUES ($1, $2, 'syn-registrar', $3)`, [id, t, `SYN-${randomUUID().slice(0, 8)}`]));
  return id;
}
function report(t: string, patientId: string): ReportRecord {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    tenantId: t,
    createdBy: 'syn-registrar',
    patientId,
    type: 'vcf',
    filename: 'synthetic.vcf',
    sizeBytes: 100,
    status: 'received',
    createdAt: now,
    updatedAt: now,
  };
}
const isDeleted = (id: string) => owner(async (c) => (await c.query<{ gone: boolean }>(`SELECT deleted_at IS NOT NULL AS gone FROM patients WHERE id = $1`, [id])).rows[0]!.gone);
const liveReports = (id: string) =>
  owner(async (c) => (await c.query<{ n: number }>(`SELECT count(*)::int AS n FROM reports WHERE patient_id = $1 AND deleted_at IS NULL`, [id])).rows[0]!.n);
const sleep = (ms: number) => new Promise<'timer'>((resolve) => setTimeout(() => resolve('timer'), ms));
/** Pauses the next unit of work after it has done everything except commit, and resumes when the returned function is called. */
function pauseBeforeCommit() {
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const arrived = new Promise<void>((resolve) => (reached = resolve));
  jest.spyOn(Database.prototype as unknown as { authorityStillCurrent(c: PoolClient, t: string): Promise<boolean> }, 'authorityStillCurrent').mockImplementationOnce(async () => {
    reached();
    await gate;
    return true;
  });
  return { arrived, release };
}
/** The invariant: a live report on a deleted patient must never exist. */
async function expectConsistent(id: string) {
  expect({ patientDeleted: await isDeleted(id), liveReports: await liveReports(id) }).not.toEqual(expect.objectContaining({ patientDeleted: true, liveReports: 1 }));
}

describe('registering a report while its patient is deleted', () => {
  it('control: with no race the report is registered and the delete is then refused by the database', async () => {
    const t = tenant();
    const p = await patient(t);
    await reports.insert(report(t, p));
    await expect(patients.delete(t, p, 'syn-actor')).rejects.toBeInstanceOf(IntegrityError);
    expect(await liveReports(p)).toBe(1);
    expect(await isDeleted(p)).toBe(false);
  });

  it('control: a report for a patient that was already deleted is refused', async () => {
    const t = tenant();
    const p = await patient(t);
    expect(await patients.delete(t, p, 'syn-actor')).toBe(true);
    await expect(reports.insert(report(t, p))).rejects.toBeInstanceOf(IntegrityError);
    expect(await liveReports(p)).toBe(0);
  });

  it('report inserted but not committed, delete arriving: the delete waits for the report and is then refused', async () => {
    const t = tenant();
    const p = await patient(t);
    const hold = pauseBeforeCommit();
    const registering = reports.insert(report(t, p)).then(
      () => 'registered' as const,
      (error: unknown) => error,
    );
    await hold.arrived; // the row is inserted, the registration has not committed
    const deleting = patients.delete(t, p, 'syn-actor').then(
      () => 'deleted' as const,
      (error: unknown) => error,
    );
    await Promise.race([deleting, sleep(1500)]); // before the fix the delete commits here; after it, it waits for the registration
    hold.release();
    const [registration, deletion] = await Promise.all([registering, deleting]);
    expect(registration).toBe('registered');
    expect(deletion).toBeInstanceOf(IntegrityError);
    await expectConsistent(p);
    expect(await isDeleted(p)).toBe(false);
  });

  it('delete done but not committed, registration arriving: the registration waits and is then refused', async () => {
    const t = tenant();
    const p = await patient(t);
    const hold = pauseBeforeCommit();
    const deleting = patients.delete(t, p, 'syn-actor').then(
      () => 'deleted' as const,
      (error: unknown) => error,
    );
    await hold.arrived; // the patient row is updated, the delete has not committed
    const registering = reports.insert(report(t, p)).then(
      () => 'registered' as const,
      (error: unknown) => error,
    );
    await Promise.race([registering, sleep(1500)]); // before the fix the registration commits here; after it, it waits for the delete
    hold.release();
    const [deletion, registration] = await Promise.all([deleting, registering]);
    expect(deletion).toBe('deleted');
    expect(registration).toBeInstanceOf(IntegrityError);
    await expectConsistent(p);
    expect(await liveReports(p)).toBe(0);
  });

  it('the same holds for a registration that carries a creation request (the replay-safe path)', async () => {
    const t = tenant();
    const p = await patient(t);
    const hold = pauseBeforeCommit();
    const registering = reports.insertOrReplay({ ...report(t, p), creationRequestId: randomUUID(), creationRequestHash: 'a'.repeat(64) }).then(
      () => 'registered' as const,
      (error: unknown) => error,
    );
    await hold.arrived;
    const deleting = patients.delete(t, p, 'syn-actor').then(
      () => 'deleted' as const,
      (error: unknown) => error,
    );
    await Promise.race([deleting, sleep(1500)]);
    hold.release();
    const [registration, deletion] = await Promise.all([registering, deleting]);
    expect(registration).toBe('registered');
    expect(deletion).toBeInstanceOf(IntegrityError);
    await expectConsistent(p);
  });
});
