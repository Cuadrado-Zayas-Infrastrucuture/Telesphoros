import { randomUUID } from 'node:crypto';
import { Database } from '../../src/db/database';
import { migrateDown } from '../../src/db/migrator';
import { newId } from '../../src/ledger/ledger-writer';
import { LedgerIntegrityError, SourceChangedError } from '../../src/ledger/ledger-types';
import { PostgresLedgerRecordsRepository } from '../../src/storage/postgres/ledger-records.repository';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { acceptanceFor, captureFor, type SeededReport, seedLabReport, sha } from '../helpers/ledger-fixtures';
import { attempt, type PgError } from '../helpers/ledger-sql';
import { Session, untilBlocked as untilBlockedOn } from '../helpers/barrier';

// Migration 0010: the stored file of a lab report is evidence, and the database itself keeps it from changing under a capture.
// Synthetic data only. Every refusal here has a control that must succeed, so a refusal cannot be an artefact of a broken fixture.

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

const INTEGRITY = '23000';
/** Runs one statement as the application role in the report's tenant and returns the error, if any. */
const asApp = (report: SeededReport, sql: string, values: unknown[] = []): Promise<PgError | undefined> =>
  attempt(pg.appUrl, report.tenantId, 'syn-actor', async (c) => {
    await c.query(sql, values);
  });
const update = (report: SeededReport, set: string, values: unknown[] = []) => asApp(report, `UPDATE reports SET ${set} WHERE id = '${report.reportId}'`, values);
const reportRow = (report: SeededReport) =>
  withAdmin(pg.adminUrl, async (c) => (await c.query(`SELECT * FROM reports WHERE id = $1`, [report.reportId])).rows[0]);

describe('the columns that pin a lab PDF', () => {
  it('requires a version and a named uploader once a lab PDF is uploaded, and refuses the storage layer\'s literal "null" version', async () => {
    const t = tenant();
    const insert = (over: Record<string, unknown>) =>
      withAdmin(pg.adminUrl, async (c) => {
        const patientId = randomUUID();
        await c.query(`INSERT INTO patients (id, tenant_id, created_by, label) VALUES ($1, $2, 'syn', $3)`, [patientId, t, `SYN-${randomUUID().slice(0, 8)}`]);
        const row = { type: 'lab-pdf', object_version: 'v1', uploaded_by: 'syn-up', uploaded_at: new Date(), ...over };
        await c.query(
          `INSERT INTO reports (tenant_id, created_by, patient_id, type, original_filename, size_bytes, content_type, sha256, storage_key, uploaded_at, object_version, uploaded_by)
           VALUES ($1, 'syn', $2, $3, 'syn.pdf', 10, 'application/pdf', $4, $5, $6, $7, $8)`,
          [t, patientId, row.type, sha(randomUUID()), `k/${randomUUID()}`, row.uploaded_at, row.object_version, row.uploaded_by],
        );
      }).then(() => undefined, (error: PgError) => error);
    expect(await insert({})).toBeUndefined(); // control
    expect((await insert({ object_version: null }))?.constraint).toBe('reports_lab_pdf_pinned');
    expect((await insert({ uploaded_by: null }))?.constraint).toBe('reports_lab_pdf_pinned');
    expect((await insert({ object_version: 'null' }))?.constraint).toBe('reports_object_version_valid');
    expect((await insert({ object_version: '' }))?.constraint).toBe('reports_object_version_valid');
    // A pin without an upload is meaningless.
    expect((await insert({ uploaded_at: null }))?.constraint).toBe('reports_pin_after_upload');
    // The older report types are untouched: no version, no uploader, uploaded.
    expect(await insert({ type: 'vcf', object_version: null, uploaded_by: null })).toBeUndefined();
  });
});

describe('once uploaded, the stored file cannot change', () => {
  it.each([
    ['sha256', `sha256 = '${'a'.repeat(64)}'`],
    ['storage_key', `storage_key = 'other/key'`],
    ['object_version', `object_version = 'another-version'`],
    ['content_type', `content_type = 'text/plain'`],
    ['size_bytes', 'size_bytes = 2000'],
    ['uploaded_at', `uploaded_at = now() + interval '1 day'`],
    ['uploaded_by', `uploaded_by = 'someone-else'`],
  ])('refuses a change of %s', async (_name, set) => {
    const report = await seedLabReport(pg.adminUrl, tenant());
    const before = await reportRow(report);
    const error = await update(report, set);
    expect(error?.code).toBe(INTEGRITY);
    expect(error?.message).toMatch(/stored file of a report cannot be changed/);
    expect(await reportRow(report)).toEqual(before);
  });

  it('still allows what is not part of the file: status, and (before any capture) the file name and deletion mark', async () => {
    const report = await seedLabReport(pg.adminUrl, tenant());
    expect(await update(report, `status = 'processing'`)).toBeUndefined();
    expect(await update(report, `original_filename = 'renamed.pdf'`)).toBeUndefined();
    expect(await update(report, `deleted_at = now()`)).toBeUndefined();
  });

  it('lets an upload be completed once: the file is recorded while uploaded_at is still empty, then frozen', async () => {
    const t = tenant();
    const pending = await withAdmin(pg.adminUrl, async (c) => {
      const patientId = randomUUID();
      const id = randomUUID();
      await c.query(`INSERT INTO patients (id, tenant_id, created_by, label) VALUES ($1, $2, 'syn', $3)`, [patientId, t, `SYN-${randomUUID().slice(0, 8)}`]);
      await c.query(`INSERT INTO reports (id, tenant_id, created_by, patient_id, type, original_filename, size_bytes) VALUES ($1, $2, 'syn', $3, 'lab-pdf', 'syn.pdf', 10)`, [id, t, patientId]);
      return id;
    });
    const complete = (version: string) =>
      attempt(pg.appUrl, t, 'syn', async (c) => {
        await c.query(
          `UPDATE reports SET sha256 = $2, storage_key = 'k/x', content_type = 'application/pdf', uploaded_at = now(), object_version = $3, uploaded_by = 'syn-up' WHERE id = $1`,
          [pending, sha('x'), version],
        );
      });
    expect(await complete('v1')).toBeUndefined(); // control: the first completion works
    expect((await complete('v2'))?.code).toBe(INTEGRITY); // the second is a change of a frozen file
  });

  it('records who asked for the first upload link once, and never lets it be replaced', async () => {
    const report = await seedLabReport(pg.adminUrl, tenant(), { requestedBy: 'syn-first' });
    expect((await update(report, `upload_requested_by = 'syn-second'`))?.code).toBe(INTEGRITY);
    expect((await reportRow(report)).upload_requested_by).toBe('syn-first');
    // Control: a report that has no requester yet can be given one, once.
    const t = tenant();
    const open = await withAdmin(pg.adminUrl, async (c) => {
      const patientId = randomUUID();
      const id = randomUUID();
      await c.query(`INSERT INTO patients (id, tenant_id, created_by, label) VALUES ($1, $2, 'syn', $3)`, [patientId, t, `SYN-${randomUUID().slice(0, 8)}`]);
      await c.query(`INSERT INTO reports (id, tenant_id, created_by, patient_id, type, original_filename, size_bytes) VALUES ($1, $2, 'syn', $3, 'lab-pdf', 'syn.pdf', 10)`, [id, t, patientId]);
      return id;
    });
    const set = (who: string) => attempt(pg.appUrl, t, 'syn', async (c) => void (await c.query(`UPDATE reports SET upload_requested_by = $2 WHERE id = $1`, [open, who])));
    expect(await set('syn-first')).toBeUndefined();
    expect((await set('syn-second'))?.code).toBe(INTEGRITY);
  });
});

describe('once a capture exists, the report is frozen further', () => {
  it.each([
    ['type', `type = 'vcf'`],
    ['original_filename', `original_filename = 'other.pdf'`],
    ['deleted_at', `deleted_at = now()`],
  ])('refuses a change of %s', async (_name, set) => {
    const report = await seedLabReport(pg.adminUrl, tenant());
    await repo.insertCapture(report.tenantId, 'syn-capturer', captureFor(report));
    const error = await update(report, set);
    expect(error?.code).toBe(INTEGRITY);
    expect(error?.message).toMatch(/with a capture cannot change/);
    expect((await reportRow(report)).deleted_at).toBeNull();
  });

  it('refuses moving the report to another patient, and controls: the same change is fine without a capture, and status still changes', async () => {
    const t = tenant();
    const report = await seedLabReport(pg.adminUrl, t);
    const other = await seedLabReport(pg.adminUrl, t);
    const free = await seedLabReport(pg.adminUrl, t);
    await repo.insertCapture(t, 'syn-capturer', captureFor(report));
    expect((await update(report, `patient_id = '${other.patientId}'`))?.code).toBe(INTEGRITY);
    expect(await update(free, `patient_id = '${other.patientId}'`)).toBeUndefined(); // control: no capture, no freeze
    expect(await update(report, `status = 'processed'`)).toBeUndefined(); // control: not part of the evidence
  });
});

describe('a capture needs a live, pinned lab PDF with the same hash', () => {
  /** A capture INSERT straight at the database (no repository comparison), so the rule that must hold even for a careless caller is what is tested. */
  const rawCapture = (report: SeededReport, pdfSha256 = report.pdfSha256) =>
    attempt(pg.appUrl, report.tenantId, 'syn-capturer', async (c) => {
      await c.query(
        `INSERT INTO report_captures (tenant_id, created_by, ledger_event_id, report_id, pdf_sha256, text_storage_key, text_sha256, text_scalars, poppler_version, runner)
         VALUES ($1, 'syn-capturer', $2, $3, $4, $5, $6, 10, '26.03.0', 'fake')`,
        [report.tenantId, randomUUID(), report.reportId, pdfSha256, `text/${randomUUID()}`, sha('text')],
      );
    });

  it('the database refuses a soft-deleted report, a hash that is not the report\'s, and another type; the repository refuses the same as "source changed"', async () => {
    const t = tenant();
    const gone = await seedLabReport(pg.adminUrl, t);
    await update(gone, `deleted_at = now()`);
    expect((await rawCapture(gone))?.code).toBe(INTEGRITY);
    await expect(repo.insertCapture(t, 'syn-capturer', captureFor(gone))).rejects.toBeInstanceOf(SourceChangedError);

    const other = await seedLabReport(pg.adminUrl, t);
    expect((await rawCapture(other, sha('some other file')))?.code).toBe(INTEGRITY);
    await expect(repo.insertCapture(t, 'syn-capturer', captureFor(other, 'text', { pdfSha256: sha('some other file') }))).rejects.toBeInstanceOf(SourceChangedError);
    expect((await repo.insertCapture(t, 'syn-capturer', captureFor(other))).created).toBe(true); // control: the matching one works
  });

  it('the database refuses a report of another type; the repository refuses it as "source changed"', async () => {
    const t = tenant();
    const report = await seedLabReport(pg.adminUrl, t);
    expect((await update(report, `type = 'vcf'`))?.code).toBe(INTEGRITY); // uploaded type is now frozen before capture
    const foreign = await seedLabReport(pg.adminUrl,t);
    const vcfId=newId(),vcfKey=`vcf/${randomUUID()}`;
    await withAdmin(pg.adminUrl,c=>c.query(`INSERT INTO reports(id,tenant_id,created_by,patient_id,type,original_filename,size_bytes,storage_key,sha256,content_type,uploaded_at,object_version,uploaded_by) VALUES($1,$2,'syn-up',$3,'vcf','inert.vcf',10,$4,$5,'text/x-vcf',now(),'syn-v','syn-up')`,[vcfId,t,foreign.patientId,vcfKey,report.pdfSha256]));
    report.reportId=vcfId;report.storageKey=vcfKey;report.objectVersion='syn-v';
    expect((await rawCapture(report))?.code).toBe(INTEGRITY);
    await expect(repo.insertCapture(t, 'syn-capturer', captureFor(report))).rejects.toBeInstanceOf(SourceChangedError);
  });

  it.each([
    ['patient', (r: SeededReport) => ({ expectedReport: { patientId: randomUUID(), sha256: r.pdfSha256, objectVersion: r.objectVersion, storageKey: r.storageKey } })],
    ['file hash', (r: SeededReport) => ({ expectedReport: { patientId: r.patientId, sha256: sha('other'), objectVersion: r.objectVersion, storageKey: r.storageKey } })],
    ['object version', (r: SeededReport) => ({ expectedReport: { patientId: r.patientId, sha256: r.pdfSha256, objectVersion: 'another-version', storageKey: r.storageKey } })],
    ['storage key', (r: SeededReport) => ({ expectedReport: { patientId: r.patientId, sha256: r.pdfSha256, objectVersion: r.objectVersion, storageKey: 'k/other' } })],
  ])('the repository refuses when the report\'s %s is not what the caller relied on, and writes nothing', async (_name, over) => {
    const t = tenant();
    const report = await seedLabReport(pg.adminUrl, t);
    await expect(repo.insertCapture(t, 'syn-capturer', captureFor(report, 'text', over(report)))).rejects.toBeInstanceOf(SourceChangedError);
    expect(await withAdmin(pg.adminUrl, async (c) => (await c.query(`SELECT count(*)::int AS n FROM report_captures WHERE report_id = $1`, [report.reportId])).rows[0].n)).toBe(0);
    expect((await repo.insertCapture(t, 'syn-capturer', captureFor(report))).created).toBe(true); // control: what is really there is accepted
  });
});

describe('who may accept a capture (four identities are excluded)', () => {
  const roles = ['syn-creator', 'syn-requester', 'syn-completer', 'syn-capturer'] as const;

  async function scenario() {
    const report = await seedLabReport(pg.adminUrl, tenant(), { uploader: 'syn-creator', requestedBy: 'syn-requester', completedBy: 'syn-completer' });
    const capture = captureFor(report);
    const c = await repo.insertCapture(report.tenantId, 'syn-capturer', capture);
    return { report, capture, c };
  }

  it.each(roles)('refuses an acceptance by %s, but lets that person reject', async (who) => {
    const { report, capture, c } = await scenario();
    await expect(repo.insertAcceptance(report.tenantId, who, acceptanceFor(c.record.id, capture))).rejects.toBeInstanceOf(LedgerIntegrityError);
    const rejected = await repo.insertAcceptance(report.tenantId, who, acceptanceFor(c.record.id, capture, { decision: 'rejected' }));
    expect(rejected.created).toBe(true);
  });

  it('accepts a fifth, independent person (control)', async () => {
    const { report, capture, c } = await scenario();
    const accepted = await repo.insertAcceptance(report.tenantId, 'syn-independent', acceptanceFor(c.record.id, capture));
    expect(accepted.created).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// The race (decision 11, 12.3). Two sessions are held at a known point by the database's own lock queue, not by sleeping or repeating.

const untilBlocked = (name: string) => untilBlockedOn(pg.adminUrl, name);

describe('a capture racing a change to the same report (decided by the lock queue, in both orders)', () => {
  const sessions: Session[] = [];
  const open = async (name: string, tenantId: string) => {
    const s = await Session.open(pg.appUrl, `${name}-${randomUUID().slice(0, 6)}`, tenantId, 'syn-capturer');
    sessions.push(s);
    return s;
  };
  afterEach(async () => {
    await Promise.all(sessions.splice(0).map((s) => s.close()));
  });
  const committedCaptures = (report: SeededReport) =>
    withAdmin(pg.adminUrl, async (c) => (await c.query(`SELECT count(*)::int AS n FROM report_captures WHERE report_id = $1`, [report.reportId])).rows[0].n as number);

  it('capture commits first: the waiting change is then refused by the frozen-report rule', async () => {
    const t = tenant();
    const report = await seedLabReport(pg.adminUrl, t);
    const unrelated = await seedLabReport(pg.adminUrl, t);
    const a = await open('cap', t);
    const b = await open('upd', t);
    const c = await open('ctl', t);
    await a.insertCapture(report); // uncommitted: holds the report row
    const outcome = b.start(`UPDATE reports SET deleted_at = now() WHERE id = $1`, [report.reportId]);
    await untilBlocked(b.name);
    // Control: a change to an UNRELATED report does not wait for this capture.
    expect(await c.start(`UPDATE reports SET deleted_at = now() WHERE id = $1`, [unrelated.reportId])).toBeUndefined();
    await a.commit();
    const error = await outcome;
    expect(error?.code).toBe(INTEGRITY);
    expect(error?.message).toMatch(/with a capture cannot change/);
    expect(await committedCaptures(report)).toBe(1);
    expect((await reportRow(report)).deleted_at).toBeNull(); // the capture describes a report that still stands
  });

  it.each([
    ['soft-delete', `deleted_at = now()`],
  ])('report change (%s) commits first: the waiting capture is refused and nothing of it remains', async (_name, set) => {
    const t = tenant();
    const report = await seedLabReport(pg.adminUrl, t);
    const unrelated = await seedLabReport(pg.adminUrl, t);
    const b = await open('upd', t);
    const a = await open('cap', t);
    const c = await open('ctl', t);
    expect(await b.start(`UPDATE reports SET ${set} WHERE id = $1`, [report.reportId])).toBeUndefined(); // uncommitted: holds the row
    const outcome = a.start(
      `INSERT INTO report_captures (tenant_id, created_by, ledger_event_id, report_id, pdf_sha256, text_storage_key, text_sha256, text_scalars, poppler_version, runner)
       VALUES ($1, 'syn-capturer', $2, $3, $4, $5, $6, 10, '26.03.0', 'fake')`,
      [t, newId(), report.reportId, report.pdfSha256, `text/${randomUUID()}`, sha('text')],
    );
    await untilBlocked(a.name);
    // Control: a capture for an UNRELATED report is not held up by the first change.
    await c.insertCapture(unrelated);
    await c.commit();
    expect(await committedCaptures(unrelated)).toBe(1);
    await b.commit();
    const error = await outcome;
    expect(error?.code).toBe(INTEGRITY);
    expect(error?.message).toMatch(/uploaded, pinned lab PDF/);
    expect(await committedCaptures(report)).toBe(0);
  });
});

describe('reverting 0010', () => {
  it('refuses to drop identities that hold data unless the session says so on purpose, and restores the 3.1 checks', async () => {
    const db = await createEphemeralDatabase();
    try {
      await seedLabReport(db.adminUrl, tenant());
      await withAdmin(db.adminUrl, async (c) => {
        // 0011 (incidents) sits above 0010 and has its own guard: revert it on purpose first, then drop the setting again so 0010's guard is what is tested.
        await c.query(`SET telesphoros.allow_audit_drop = 'yes'`);
        expect(await migrateDown(c, 7)).toEqual(['0018', '0017', '0016', '0015', '0014', '0013', '0012']);
        expect(await migrateDown(c, 1)).toEqual(['0011']);
        await c.query(`RESET telesphoros.allow_audit_drop`);
        await expect(migrateDown(c, 1)).rejects.toThrow(/Refusing to drop report evidence/);
        await c.query(`SET telesphoros.allow_audit_drop = 'yes'`);
        expect(await migrateDown(c, 1)).toEqual(['0010']);
        const columns = await c.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'reports' AND column_name IN ('object_version', 'uploaded_by', 'upload_requested_by')`);
        expect(columns.rows).toEqual([]);
        const triggers = await c.query(`SELECT 1 FROM pg_trigger WHERE tgname = 'reports_evidence_guard'`);
        expect(triggers.rowCount).toBe(0);
      });
    } finally {
      await db.drop();
    }
  });
});
