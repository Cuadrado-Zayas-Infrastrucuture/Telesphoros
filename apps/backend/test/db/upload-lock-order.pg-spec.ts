import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { Database } from '../../src/db/database';
import { PostgresReportsRepository } from '../../src/storage/postgres/reports.repository';
import * as retry from '../../src/storage/postgres/retry-conflict';
import type { ReportRecord } from '../../src/storage/records';
import type { AttemptIdentity, UploadAttempt } from '../../src/storage/upload-attempt';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';

// The real retry by default; the overlap tests below turn it off, because a retry would hide a deadlock and they are about the lock order.
jest.mock('../../src/storage/postgres/retry-conflict', () => {
  const actual = jest.requireActual<typeof import('../../src/storage/postgres/retry-conflict')>('../../src/storage/postgres/retry-conflict');
  return { ...actual, retryOnConflict: jest.fn(actual.retryOnConflict) };
});
const retryMock = retry.retryOnConflict as unknown as jest.Mock;
const realRetry = jest.requireActual<typeof import('../../src/storage/postgres/retry-conflict')>('../../src/storage/postgres/retry-conflict').retryOnConflict;

/**
 * Declaring a new upload attempt for a report while an earlier attempt for the same report is being committed. Declare took the run row, then the report row; commit took
 * the report row, then the run row: the same two rows in opposite orders, so two overlapping calls can each hold one and wait for the other (SQLSTATE 40P01). The window
 * is microseconds in real use; a synthetic trigger that sleeps while the run row is held (never present in a deployment) opens it wide enough to hit every time.
 */
let pg: EphemeralDatabase;
let database: Database;
let reports: PostgresReportsRepository;
beforeAll(async () => {
  pg = await createEphemeralDatabase();
  database = new Database({ url: pg.appUrl, ssl: 'disable' });
  reports = new PostgresReportsRepository(database);
});
afterAll(async () => {
  await database?.onModuleDestroy();
  await pg?.drop();
});

const owner = <T>(work: (c: Client) => Promise<T>) => withAdmin(pg.adminUrl, work);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const SHA = 'a'.repeat(64);

interface Fixture { tenant: string; reportId: string; patientId: string; revision: string; run: string }
async function fixture(): Promise<Fixture> {
  const tenant = `tenant-${randomUUID().slice(0, 8)}`;
  const patientId = randomUUID();
  await owner((c) => c.query(`INSERT INTO patients (id, tenant_id, created_by, label) VALUES ($1, $2, 'syn-registrar', $3)`, [patientId, tenant, `SYN-${randomUUID().slice(0, 8)}`]));
  const now = new Date().toISOString();
  const record: ReportRecord = { id: randomUUID(), tenantId: tenant, createdBy: 'syn-registrar', patientId, type: 'vcf', filename: 'synthetic.vcf', sizeBytes: 100, status: 'received', createdAt: now, updatedAt: now };
  await reports.insert(record);
  const revision = await owner(async (c) => (await c.query<{ r: string }>(`SELECT upload_revision::text AS r FROM reports WHERE id = $1`, [record.id])).rows[0]!.r);
  return { tenant, reportId: record.id, patientId, revision, run: randomUUID() };
}
function attempt(f: Fixture): UploadAttempt {
  const id = randomUUID();
  return {
    id, requestId: randomUUID(), runId: f.run, tenantId: f.tenant, reportId: f.reportId, patientId: f.patientId, principal: 'syn-registrar', revision: f.revision, declarationRevision: f.revision,
    type: 'vcf', sizeBytes: 100, contentType: 'text/plain', sha256: SHA, key: `reports/${f.tenant}/${f.reportId}/${id}`, cancelRequested: false, validated: false, state: 'declared',
    version: null, leaseUntil: new Date(Date.now() + 3_600_000).toISOString(), writer: null, createdAt: new Date().toISOString(),
  };
}
const identity = (a: UploadAttempt): AttemptIdentity => ({ tenantId: a.tenantId, reportId: a.reportId, id: a.id, principal: a.principal, revision: a.revision });

/** An attempt that is declared, received, validated and stored: ready to commit. */
async function storedAttempt(f: Fixture): Promise<UploadAttempt> {
  const declared = await reports.declareAttempt(attempt(f), f.revision);
  if (!declared) throw new Error('the first declaration should succeed');
  const i = identity(declared);
  const writer = randomUUID();
  expect(await reports.beginAttempt(i, writer)).toBeTruthy();
  expect(await reports.validateAttempt(i, writer)).toBeTruthy();
  expect(await reports.settleAttempt(i, writer, 'stored', 'version-1')).toBeTruthy();
  return declared;
}

describe('a declaration and a commit for the same report', () => {
  // The retry would hide a deadlock, so these tests run without it: they prove the lock ORDER prevents the deadlock, not that a retry recovers from it.
  beforeEach(() => { retryMock.mockImplementation((work: () => Promise<unknown>) => work()); });
  afterEach(() => { retryMock.mockImplementation(realRetry); });

  beforeAll(async () => {
    // Holds the run row for half a second after a declaration reserves bytes in it, before the declaration goes on to the report row.
    await owner(async (c) => {
      await c.query(`CREATE FUNCTION syn_slow_run() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.reserved_bytes > OLD.reserved_bytes THEN PERFORM pg_sleep(0.5); END IF; RETURN NEW; END $$`);
      await c.query(`CREATE TRIGGER syn_slow_run AFTER UPDATE ON report_upload_runs FOR EACH ROW EXECUTE FUNCTION syn_slow_run()`);
    });
  });

  it('do not deadlock when they overlap: both finish, with no 40P01 and no retry to hide one', async () => {
    const f = await fixture();
    const first = await storedAttempt(f);
    const second = attempt(f);
    const declare = reports.declareAttempt(second, first.revision); // takes the run row, sleeps in the trigger, then wants the report row
    await sleep(150);
    const commit = reports.commitAttempt(identity(first)); // takes the report row, then wants the run row
    const [d, c] = await Promise.allSettled([declare, commit]);
    expect([d.status, c.status].map((s, n) => [n === 0 ? 'declare' : 'commit', s, (n === 0 ? d : c).status === 'rejected' ? ((n === 0 ? d : c) as PromiseRejectedResult).reason?.code : undefined])).toEqual([
      ['declare', 'fulfilled', undefined],
      ['commit', 'fulfilled', undefined],
    ]);
  }, 30_000);

  it('leave the report in one consistent state either way: the second declaration is the live one and the first cannot commit, or the reverse', async () => {
    const f = await fixture();
    const first = await storedAttempt(f);
    const second = attempt(f);
    const [declared, committed] = await Promise.all([reports.declareAttempt(second, first.revision), sleep(150).then(() => reports.commitAttempt(identity(first)))]);
    const row = await owner(async (c) => (await c.query<{ uploaded: boolean }>(`SELECT uploaded_at IS NOT NULL AS uploaded FROM reports WHERE id = $1`, [f.reportId])).rows[0]!);
    const reserved = await owner(async (c) => (await c.query<{ n: number }>(`SELECT reserved_bytes::int AS n FROM report_upload_runs WHERE run_id = $1`, [f.run])).rows[0]!.n);
    // Exactly one of them won: either the new declaration (the first attempt can no longer commit) or the commit (the new declaration finds the report uploaded).
    expect(Boolean(declared) !== committed).toBe(true);
    expect(row.uploaded).toBe(committed);
    expect(reserved).toBe(declared ? 200 : 0); // the declaration's 100 bytes are reserved only when it won; the committed attempt's are released
  }, 30_000);

  it('still work one after the other (control: no overlap, no trigger delay in the way)', async () => {
    const f = await fixture();
    const first = await storedAttempt(f);
    expect(await reports.commitAttempt(identity(first))).toBe(true);
    expect(await reports.declareAttempt(attempt(f), first.revision)).toBeUndefined(); // the report is uploaded: a new declaration is refused
  }, 30_000);
});

describe('a deadlock the order does not prevent is retried once', () => {
  afterEach(() => jest.restoreAllMocks());
  const conflict = () => Object.assign(new Error('deadlock detected'), { code: '40P01' });

  it('declareAttempt and commitAttempt repeat their transaction after a 40P01 and succeed', async () => {
    const f = await fixture();
    const real = Database.prototype.withTenant;
    let failing = 0;
    jest.spyOn(Database.prototype, 'withTenant').mockImplementation(function (this: Database, ...args: Parameters<Database['withTenant']>) {
      if (failing > 0) { failing -= 1; return Promise.reject(conflict()); }
      return real.apply(this, args);
    });
    failing = 1;
    const first = await reports.declareAttempt(attempt(f), f.revision);
    expect(first).toBeTruthy();
    jest.restoreAllMocks();
    const i = identity(first!);
    const writer = randomUUID();
    await reports.beginAttempt(i, writer);
    await reports.validateAttempt(i, writer);
    await reports.settleAttempt(i, writer, 'stored', 'version-1');
    jest.spyOn(Database.prototype, 'withTenant').mockImplementation(function (this: Database, ...args: Parameters<Database['withTenant']>) {
      if (failing > 0) { failing -= 1; return Promise.reject(conflict()); }
      return real.apply(this, args);
    });
    failing = 1;
    expect(await reports.commitAttempt(i)).toBe(true);
  }, 30_000);

  it('gives up after one retry, and does not retry other errors', async () => {
    const f = await fixture();
    jest.spyOn(Database.prototype, 'withTenant').mockImplementation(() => Promise.reject(conflict()));
    await expect(reports.declareAttempt(attempt(f), f.revision)).rejects.toMatchObject({ code: '40P01' });
    expect(Database.prototype.withTenant).toHaveBeenCalledTimes(2);
    jest.restoreAllMocks();
    jest.spyOn(Database.prototype, 'withTenant').mockImplementation(() => Promise.reject(Object.assign(new Error('unique'), { code: '23505' })));
    await expect(reports.declareAttempt(attempt(f), f.revision)).rejects.toMatchObject({ code: '23505' });
    expect(Database.prototype.withTenant).toHaveBeenCalledTimes(1);
  }, 30_000);
});
