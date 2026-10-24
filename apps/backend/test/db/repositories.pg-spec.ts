import { randomUUID } from 'node:crypto';
import { Database } from '../../src/db/database';
import { IntegrityError } from '../../src/storage/errors';
import { InMemoryPatientsRepository, PatientsRepository } from '../../src/storage/patients.repository';
import { PostgresPatientsRepository } from '../../src/storage/postgres/patients.repository';
import { PostgresRecommendationsRepository } from '../../src/storage/postgres/recommendations.repository';
import { PostgresReportsRepository } from '../../src/storage/postgres/reports.repository';
import { InMemoryRecommendationsRepository, RecommendationsRepository } from '../../src/storage/recommendations.repository';
import type { PatientRecord, RecommendationRecord, ReportRecord } from '../../src/storage/records';
import { InMemoryReportsRepository, ReportsRepository } from '../../src/storage/reports.repository';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { declareUpload, finishUpload } from '../helpers/uploads';

interface Stores {
  patients: PatientsRepository;
  reports: ReportsRepository;
  recommendations: RecommendationsRepository;
  close(): Promise<void>;
}

const stamp = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
const patient = (tenantId: string, label: string, createdAt = stamp()): PatientRecord => ({
  id: randomUUID(), tenantId, createdBy: 'syn-actor', label, createdAt, updatedAt: createdAt,
});
const report = (tenantId: string, patientId: string, over: Partial<ReportRecord> = {}): ReportRecord => ({
  id: randomUUID(), tenantId, createdBy: 'syn-actor', patientId, type: 'vcf', filename: 'a.vcf', sizeBytes: 100, status: 'received',
  storageKey: null, contentType: null, sha256: null, uploadedAt: null, objectVersion: null, uploadRequestedBy: null, uploadedBy: null,
  createdAt: stamp(), updatedAt: stamp(), ...over,
});
const recommendation = (tenantId: string, patientId: string, reportId: string, over: Partial<RecommendationRecord> = {}): RecommendationRecord => ({
  id: randomUUID(), tenantId, createdBy: 'syn-actor', patientId, reportId, gene: 'G', drug: 'd', phenotype: 'p', summary: 's',
  strength: 'Strong', guidelineVersion: 'v0', createdAt: stamp(), ...over,
});

let pgDb: EphemeralDatabase;
let database: Database;
beforeAll(async () => {
  pgDb = await createEphemeralDatabase();
  database = new Database({ url: pgDb.appUrl, ssl: 'disable' });
});
afterAll(async () => {
  await database.onModuleDestroy();
  await pgDb.drop();
});

const memory = async (): Promise<Stores> => ({
  patients: new InMemoryPatientsRepository(),
  reports: new InMemoryReportsRepository(),
  recommendations: new InMemoryRecommendationsRepository(),
  close: async () => undefined,
});
// The Postgres stores share one database, so each test uses its own tenant ids to stay independent.
const postgres = async (): Promise<Stores> => ({
  patients: new PostgresPatientsRepository(database),
  reports: new PostgresReportsRepository(database),
  recommendations: new PostgresRecommendationsRepository(database),
  close: async () => undefined,
});

// ---------------------------------------------------------------------------------------------
// One contract, run against BOTH implementations: they must be interchangeable.
// ---------------------------------------------------------------------------------------------
describe.each([['in-memory', memory], ['postgres', postgres]] as const)('repository contract: %s', (_name, make) => {
  const tenant = () => `tenant-${randomUUID()}`;

  describe('patients', () => {
    it('round-trips a record exactly (including timestamps) and finds it by label, ignoring case', async () => {
      const { patients } = await make();
      const o = tenant();
      const p = patient(o, 'SYN-1');
      await patients.insert(p);
      expect(await patients.findById(o, p.id)).toEqual(p);
      expect(await patients.findByLabel(o, 'syn-1')).toEqual(p);
      expect(await patients.findByLabel(o, 'SYN-2')).toBeUndefined();
    });

    it('is tenant-scoped on every read and write', async () => {
      const { patients } = await make();
      const [a, b] = [tenant(), tenant()];
      const p = patient(a, 'SYN-1');
      await patients.insert(p);
      expect(await patients.findById(b, p.id)).toBeUndefined();
      expect(await patients.findByLabel(b, 'SYN-1')).toBeUndefined();
      expect((await patients.list(b, { offset: 0, limit: 10 })).total).toBe(0);
      expect(await patients.delete(b, p.id, 'syn-actor')).toBe(false);
      expect(await patients.findById(a, p.id)).toBeDefined();
    });

    it('lists in CREATION order even when timestamps tie, with correct totals and pages', async () => {
      const { patients } = await make();
      const o = tenant();
      const sameInstant = stamp();
      for (let i = 1; i <= 5; i++) await patients.insert(patient(o, `SYN-${i}`, sameInstant));
      const page = await patients.list(o, { offset: 2, limit: 2 });
      expect(page.total).toBe(5);
      expect(page.items.map((p) => p.label)).toEqual(['SYN-3', 'SYN-4']);
      expect((await patients.list(o, { offset: 50, limit: 2 })).items).toEqual([]);
      expect((await patients.list(o, { offset: 50, limit: 2 })).total).toBe(5);
    });

    it('updates the label and timestamp', async () => {
      const { patients } = await make();
      const o = tenant();
      const p = patient(o, 'SYN-1');
      await patients.insert(p);
      const changed = { ...p, label: 'SYN-9', updatedAt: stamp(5000) };
      await patients.update(changed);
      expect(await patients.findById(o, p.id)).toEqual(changed);
    });

    it('soft delete: hidden from reads and lists, reported once, and the label becomes reusable', async () => {
      const { patients } = await make();
      const o = tenant();
      const p = patient(o, 'SYN-1');
      await patients.insert(p);
      expect(await patients.delete(o, p.id, 'syn-actor')).toBe(true);
      expect(await patients.findById(o, p.id)).toBeUndefined();
      expect(await patients.findByLabel(o, 'SYN-1')).toBeUndefined();
      expect((await patients.list(o, { offset: 0, limit: 10 })).total).toBe(0);
      expect(await patients.delete(o, p.id, 'syn-actor')).toBe(false);
      await expect(patients.insert(patient(o, 'SYN-1'))).resolves.toBeUndefined();
    });
  });

  describe('reports', () => {
    it('round-trips upload fields, filters by patient, and counts only live reports', async () => {
      const { patients, reports } = await make();
      const o = tenant();
      const [p1, p2] = [patient(o, 'SYN-A'), patient(o, 'SYN-B')];
      await patients.insert(p1);
      await patients.insert(p2);
      const uploaded = report(o, p1.id, {
        storageKey: `reports/${randomUUID()}`, contentType: 'text/plain', sha256: 'a'.repeat(64), uploadedAt: stamp(),
      });
      await reports.insert(uploaded);
      await reports.insert(report(o, p1.id));
      await reports.insert(report(o, p2.id));

      expect(await reports.findById(o, uploaded.id)).toEqual({...uploaded, uploadRevision:expect.any(String),deletedAt:null});
      expect((await reports.list(o, { offset: 0, limit: 10 }, { patientId: p1.id })).total).toBe(2);
      expect((await reports.list(o, { offset: 0, limit: 10 }, {})).total).toBe(3);
      expect(await reports.countByPatient(o, p1.id)).toBe(2);
      await reports.delete(o, uploaded.id);
      expect(await reports.countByPatient(o, p1.id)).toBe(1);
    });

    it('persists updates, including completing an upload', async () => {
      const { patients, reports } = await make();
      const o = tenant();
      const p = patient(o, 'SYN-A');
      await patients.insert(p);
      const r = report(o, p.id);
      await reports.insert(r);
      const edited = { ...r, filename: 'b.json', type: 'structured' as const, status: 'processing' as const, updatedAt: stamp(10) };
      await reports.update(edited);
      expect(await reports.findById(o, r.id)).toEqual({...edited, uploadRevision:expect.any(String),deletedAt:null});
    });

    it('update() never touches the stored file: only type, file name and status change', async () => {
      const { patients, reports } = await make();
      const o = tenant();
      const p = patient(o, 'SYN-A');
      await patients.insert(p);
      const r = report(o, p.id);
      await reports.insert(r);
      const hash = 'c'.repeat(64);
      const declared = (await declareUpload(reports, r, { principal: 'syn-first', sha256: hash, contentType: 'application/json', key: 'k/1' }))!;
      expect(declared).toBeDefined();
      // A stale copy of the record, written back by update(), must not erase or replace the declared file.
      await reports.update({ ...r, filename: 'c.vcf', storageKey: 'other', sha256: 'd'.repeat(64), uploadRequestedBy: 'syn-other', updatedAt: stamp(10) });
      expect(await reports.findById(o, r.id)).toMatchObject({ filename: 'c.vcf', storageKey: 'k/1', sha256: hash, uploadRequestedBy: 'syn-first' });
    });

    it('records the declared file and the FIRST requester, then pins the upload exactly once, to the person who sent it', async () => {
      const { patients, reports } = await make();
      const o = tenant();
      const p = patient(o, 'SYN-A');
      await patients.insert(p);
      const r = report(o, p.id);
      await reports.insert(r);
      const hash = 'b'.repeat(64);
      const first = (await declareUpload(reports, r, { principal: 'syn-first', sha256: hash, contentType: 'application/json' }))!;
      expect(await reports.findById(o, r.id)).toMatchObject({ uploadRequestedBy: 'syn-first', sha256: hash, uploadedAt: null, storageKey: first.attempt.key });
      // Declaring again before the upload completes is allowed and changes nobody's identity, but it supersedes the earlier attempt (the report's revision moves).
      const second = (await declareUpload(reports, r, { principal: 'syn-second', sha256: hash, contentType: 'application/json' }))!;
      expect(second).toBeDefined();
      expect(await reports.findById(o, r.id)).toMatchObject({ uploadRequestedBy: 'syn-first', sha256: hash, uploadedAt: null, storageKey: second.attempt.key });
      expect(await finishUpload(reports, first, 'ver-0')).toBe(false); // stale revision cannot pin

      expect(await finishUpload(reports, second, 'ver-1')).toBe(true);
      expect(await reports.findById(o, r.id)).toMatchObject({ objectVersion: 'ver-1', uploadedBy: 'syn-second', uploadRequestedBy: 'syn-first', sha256: hash });
      expect(await reports.findById(o, r.id)).toMatchObject({ uploadedAt: expect.any(String) });

      // A late declaration, and a late commit attempt by someone else, find the upload already done and change nothing.
      expect(await declareUpload(reports, r, { principal: 'syn-late', sha256: 'e'.repeat(64), contentType: 'application/json', expectedRevision: second.attempt.revision })).toBeUndefined();
      expect(await reports.commitAttempt(first.identity)).toBe(false);
      expect(await reports.findById(o, r.id)).toMatchObject({ objectVersion: 'ver-1', uploadedBy: 'syn-second', sha256: hash, uploadRequestedBy: 'syn-first' });
    });

    it('is tenant-scoped', async () => {
      const { patients, reports } = await make();
      const [a, b] = [tenant(), tenant()];
      const p = patient(a, 'SYN-A');
      await patients.insert(p);
      const r = report(a, p.id);
      await reports.insert(r);
      expect(await reports.findById(b, r.id)).toBeUndefined();
      expect((await reports.list(b, { offset: 0, limit: 10 }, {})).total).toBe(0);
      expect(await reports.delete(b, r.id)).toBe(false);
    });
  });

  describe('recommendations', () => {
    it('lists, filters and fetches, scoped to the tenant', async () => {
      const { patients, reports, recommendations } = await make();
      const [a, b] = [tenant(), tenant()];
      const pa = patient(a, 'SYN-A');
      const pb = patient(b, 'SYN-B');
      await patients.insert(pa);
      await patients.insert(pb);
      const ra1 = report(a, pa.id);
      const ra2 = report(a, pa.id);
      const rb = report(b, pb.id);
      for (const r of [ra1, ra2, rb]) await reports.insert(r);
      const rec1 = recommendation(a, pa.id, ra1.id);
      await recommendations.insert(rec1);
      await recommendations.insert(recommendation(a, pa.id, ra2.id));
      await recommendations.insert(recommendation(b, pb.id, rb.id));

      expect((await recommendations.list(a, { offset: 0, limit: 10 }, {})).total).toBe(2);
      expect((await recommendations.list(a, { offset: 0, limit: 10 }, { reportId: ra1.id })).total).toBe(1);
      expect((await recommendations.list(a, { offset: 0, limit: 10 }, { patientId: pa.id })).total).toBe(2);
      expect(await recommendations.findById(a, rec1.id)).toEqual(rec1);
      expect(await recommendations.findById(b, rec1.id)).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------------------------
// PostgreSQL-only guarantees: the database itself says no, whatever the application does.
// ---------------------------------------------------------------------------------------------
describe('postgres: what only the database can guarantee', () => {
  const tenant = () => `tenant-${randomUUID()}`;
  const stores = () => ({
    patients: new PostgresPatientsRepository(database),
    reports: new PostgresReportsRepository(database),
  });

  it('two racing inserts of the same label: exactly one wins, the loser gets an IntegrityError (not a 500)', async () => {
    const { patients } = stores();
    const o = tenant();
    const results = await Promise.allSettled([patients.insert(patient(o, 'SYN-RACE')), patients.insert(patient(o, 'SYN-RACE'))]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(IntegrityError);
  });

  it('soft delete keeps the row (audit trail) and stamps deleted_at', async () => {
    const { patients } = stores();
    const o = tenant();
    const p = patient(o, 'SYN-KEEP');
    await patients.insert(p);
    await patients.delete(o, p.id, 'syn-actor');
    const row = await withAdmin(pgDb.adminUrl, (c) => c.query('SELECT deleted_at FROM patients WHERE id = $1', [p.id]));
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].deleted_at).toBeInstanceOf(Date);
  });

  it('refuses to soft-delete a patient that still has live reports, and allows it once they are gone', async () => {
    const { patients, reports } = stores();
    const o = tenant();
    const p = patient(o, 'SYN-GUARD');
    await patients.insert(p);
    const r = report(o, p.id);
    await reports.insert(r);
    await expect(patients.delete(o, p.id, 'syn-actor')).rejects.toBeInstanceOf(IntegrityError);
    await reports.delete(o, r.id);
    await expect(patients.delete(o, p.id, 'syn-actor')).resolves.toBe(true);
  });

  it('refuses a report that points at another tenant’s patient', async () => {
    const { patients, reports } = stores();
    const [a, b] = [tenant(), tenant()];
    const p = patient(a, 'SYN-X');
    await patients.insert(p);
    await expect(reports.insert(report(b, p.id))).rejects.toBeInstanceOf(IntegrityError);
  });

  it('refuses to register the same storage key for two reports', async () => {
    const { patients, reports } = stores();
    const o = tenant();
    const p = patient(o, 'SYN-KEY');
    await patients.insert(p);
    const key = `reports/${randomUUID()}`;
    const withKey = { storageKey: key, contentType: 'text/plain', sha256: 'c'.repeat(64), uploadedAt: stamp() };
    await reports.insert(report(o, p.id, withKey));
    await expect(reports.insert(report(o, p.id, withKey))).rejects.toBeInstanceOf(IntegrityError);
  });
});
