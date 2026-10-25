import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { Database } from '../../src/db/database';
import { organizationRunId } from '../../src/reports/intake/scope';
import { runUploads, sweepTenantUploads } from '../../src/reports/intake/sweep';
import { PostgresPatientsRepository } from '../../src/storage/postgres/patients.repository';
import { PostgresReportsRepository } from '../../src/storage/postgres/reports.repository';
import type { ReportRecord } from '../../src/storage/records';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { registerTenantRow } from '../helpers/membership';
import { commitUpload, declareUpload } from '../helpers/uploads';

// The operator's sweep of abandoned intake attempts (M2.2b): what it closes, what it must leave alone, and that it deletes nothing but a reservation.
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

const tenant = () => `syn-sweep-${randomUUID().slice(0, 8)}`;
async function newReport(tenantId: string, size = 1000): Promise<ReportRecord> {
  const p = {
    id: randomUUID(),
    tenantId,
    createdBy: 'syn-actor',
    label: `SYN-${randomUUID().slice(0, 8)}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await patients.insert(p);
  const r: ReportRecord = {
    id: randomUUID(),
    tenantId,
    createdBy: 'syn-actor',
    patientId: p.id,
    type: 'vcf',
    filename: 'a.vcf',
    sizeBytes: size,
    status: 'received',
    storageKey: null,
    contentType: null,
    sha256: null,
    uploadedAt: null,
    objectVersion: null,
    uploadRequestedBy: null,
    uploadedBy: null,
    createdAt: p.createdAt,
    updatedAt: p.createdAt,
  };
  await reports.insert(r);
  return r;
}
const owner = <T>(work: (c: Client) => Promise<T>) => withAdmin(db.adminUrl, work);
// A tenant binds through its capability row, which needs the tenant row (0032): register it before the sweep, as the application does on first use.
const sweepRegistered = async (c: Client, tenantId: string, options: Parameters<typeof sweepTenantUploads>[2]) => {
  await registerTenantRow(c, tenantId);
  return sweepTenantUploads(c, tenantId, options);
};
const asApp = async <T>(work: (c: Client) => Promise<T>) => {
  const c = new Client({ connectionString: db.appUrl });
  await c.connect();
  try {
    return await work(c);
  } finally {
    await c.end();
  }
};
const stateOf = (id: string) => owner(async (c) => (await c.query('SELECT state FROM report_upload_attempts WHERE id = $1', [id])).rows[0]?.state as string);
const reserved = (t: string) =>
  owner(async (c) =>
    Number((await c.query('SELECT reserved_bytes FROM report_upload_runs WHERE tenant_id = $1 AND run_id = $2', [t, organizationRunId(t)])).rows[0]?.reserved_bytes ?? 0),
  );
const age = (id: string, seconds: number) => owner((c) => c.query(`UPDATE report_upload_attempts SET lease_until = now() - $2 * interval '1 second' WHERE id = $1`, [id, seconds]));

describe('closing abandoned attempts', () => {
  it('closes an old declaration and an old stored attempt, returns their quota, and says which may have left an object; a fresh one, a committed one and a held one stay', async () => {
    const t = tenant();
    const [old, stored, fresh, committed, held] = await Promise.all([newReport(t, 1000), newReport(t, 2000), newReport(t, 4000), newReport(t, 8000), newReport(t, 16000)]);
    const hOld = (await declareUpload(reports, old, { principal: 'p', sha256: HASH, contentType: 'text/x-vcf' }))!;
    const hStored = (await declareUpload(reports, stored, { principal: 'p', sha256: HASH, contentType: 'text/x-vcf' }))!;
    const hFresh = (await declareUpload(reports, fresh, { principal: 'p', sha256: HASH, contentType: 'text/x-vcf' }))!;
    const hCommitted = await commitUpload(reports, committed, { principal: 'p', sha256: HASH, contentType: 'text/x-vcf', version: 'v-commit' });
    const hHeld = (await declareUpload(reports, held, { principal: 'p', sha256: HASH, contentType: 'text/x-vcf' }))!;
    // The stored attempt wrote an object and was never committed; the held one has a live writer.
    const writer = randomUUID();
    expect(await reports.beginAttempt(hStored.identity, writer)).toBe(true);
    expect(await reports.validateAttempt(hStored.identity, writer)).toBe(true);
    expect(await reports.settleAttempt(hStored.identity, writer, 'stored', 'v-stored')).toBe(true);
    expect(await reports.beginAttempt(hHeld.identity, randomUUID())).toBe(true);
    expect(await reserved(t)).toBe(1000 + 2000 + 4000 + 16000); // the committed one's share was already returned
    for (const h of [hOld, hStored, hHeld]) await age(h.attempt.id, 3 * 86400);
    await owner((c) => c.query(`UPDATE report_upload_attempts SET lease_until = now() + interval '1 hour' WHERE id = $1`, [hHeld.attempt.id])); // the writer's lease is current

    const result = await owner((c) => sweepRegistered(c, t, { graceSeconds: 86400, dryRun: false }));
    expect(result).toEqual({ tenantId: t, released: 2, releasedBytes: 3000, objectsKept: 1 });
    expect(await stateOf(hOld.attempt.id)).toBe('cleaned');
    expect(await stateOf(hStored.attempt.id)).toBe('cleaned');
    expect(await stateOf(hFresh.attempt.id)).toBe('declared');
    expect(await stateOf(hCommitted.attempt.id)).toBe('committed');
    expect(await stateOf(hHeld.attempt.id)).toBe('intaking');
    expect(await reserved(t)).toBe(4000 + 16000);
    // Running it again finds nothing (idempotent), and the report whose attempt was closed can declare again.
    expect(await owner((c) => sweepRegistered(c, t, { graceSeconds: 86400, dryRun: false }))).toMatchObject({ released: 0 });
    const again = await declareUpload(reports, old, {
      principal: 'p',
      sha256: HASH,
      contentType: 'text/x-vcf',
      expectedRevision: (await reports.findById(t, old.id))!.uploadRevision,
    });
    expect(again).toBeDefined();
  });

  it('leaves alone a cancelled attempt a writer still holds (it is closed once the writer has let go)', async () => {
    const t = tenant();
    const r = await newReport(t, 900);
    const h = (await declareUpload(reports, r, { principal: 'p', sha256: HASH, contentType: 'text/x-vcf' }))!;
    await owner((c) =>
      c.query(`UPDATE report_upload_attempts SET state = 'cancelled', writer = $2, lease_until = now() + interval '1 hour' WHERE id = $1`, [h.attempt.id, randomUUID()]),
    );
    expect(await owner((c) => sweepRegistered(c, t, { graceSeconds: 0, dryRun: false }))).toMatchObject({ released: 0 });
    expect(await stateOf(h.attempt.id)).toBe('cancelled');
    await owner((c) => c.query(`UPDATE report_upload_attempts SET writer = NULL WHERE id = $1`, [h.attempt.id]));
    expect(await owner((c) => sweepRegistered(c, t, { graceSeconds: 0, dryRun: false }))).toMatchObject({ released: 1, releasedBytes: 900 });
  });

  it('respects the grace period (control: the same attempt is closed with a shorter one), closes a cancelled attempt at once, and a dry run changes nothing', async () => {
    const t = tenant();
    const [a, b] = await Promise.all([newReport(t, 500), newReport(t, 700)]);
    const ha = (await declareUpload(reports, a, { principal: 'p', sha256: HASH, contentType: 'text/x-vcf' }))!;
    const hb = (await declareUpload(reports, b, { principal: 'p', sha256: HASH, contentType: 'text/x-vcf' }))!;
    await age(ha.attempt.id, 2 * 3600); // lease ended two hours ago
    await reports.cancelAttempt(hb.identity); // cancelled just now
    expect(await owner((c) => sweepRegistered(c, t, { graceSeconds: 86400, dryRun: true }))).toMatchObject({ released: 1, releasedBytes: 700 }); // only the cancelled one
    expect(await stateOf(hb.attempt.id)).toBe('cancelled'); // dry run: nothing changed
    expect(await reserved(t)).toBe(1200);
    expect(await owner((c) => sweepRegistered(c, t, { graceSeconds: 86400, dryRun: false }))).toMatchObject({ released: 1, releasedBytes: 700 });
    expect(await stateOf(ha.attempt.id)).toBe('declared'); // inside the grace
    expect(await owner((c) => sweepRegistered(c, t, { graceSeconds: 3600, dryRun: false }))).toMatchObject({ released: 1, releasedBytes: 500 });
    expect(await reserved(t)).toBe(0);
  });

  it("sweeps only the organization it is given, refuses the application login, and never touches another organization's attempts", async () => {
    const [t1, t2] = [tenant(), tenant()];
    const [r1, r2] = await Promise.all([newReport(t1, 100), newReport(t2, 200)]);
    const h1 = (await declareUpload(reports, r1, { principal: 'p', sha256: HASH, contentType: 'text/x-vcf' }))!;
    const h2 = (await declareUpload(reports, r2, { principal: 'p', sha256: HASH, contentType: 'text/x-vcf' }))!;
    await age(h1.attempt.id, 3 * 86400);
    await age(h2.attempt.id, 3 * 86400);
    // The sweep is the queue owner's function (migration 0024): the application login cannot run it, so a request can never sweep.
    await expect(asApp((c) => sweepRegistered(c, t1, { graceSeconds: 86400, dryRun: false }))).rejects.toThrow(/permission denied/);
    await expect(asApp((c) => c.query('SELECT * FROM uploads_sweep($1, 0, false)', [t1]))).rejects.toThrow(/permission denied/);
    expect(await owner((c) => sweepRegistered(c, t1, { graceSeconds: 86400, dryRun: false }))).toMatchObject({ released: 1, releasedBytes: 100 });
    expect(await stateOf(h1.attempt.id)).toBe('cleaned');
    expect(await stateOf(h2.attempt.id)).toBe('declared');
    expect(await reserved(t2)).toBe(200);
    // The sweep of the whole registry reaches the other one (control).
    expect(await owner((c) => sweepRegistered(c, t2, { graceSeconds: 86400, dryRun: false }))).toMatchObject({ released: 1 });
  });

  it('deletes no object, no report and no committed row, and refuses a grace outside its range', async () => {
    const t = tenant();
    const r = await newReport(t, 300);
    const h = await commitUpload(reports, r, { principal: 'p', sha256: HASH, contentType: 'text/x-vcf', version: 'v1' });
    const before = await owner(async (c) => (await c.query('SELECT * FROM reports WHERE id = $1', [r.id])).rows[0]);
    await owner((c) => sweepRegistered(c, t, { graceSeconds: 0, dryRun: false }));
    expect(await owner(async (c) => (await c.query('SELECT * FROM reports WHERE id = $1', [r.id])).rows[0])).toEqual(before);
    expect(await stateOf(h.attempt.id)).toBe('committed');
    for (const bad of [-1, 1.5, 604801]) await expect(owner((c) => sweepRegistered(c, t, { graceSeconds: bad, dryRun: false }))).rejects.toThrow(/graceSeconds/);
  });
});

describe('the uploads sweep command', () => {
  it('reports per organization and in total, supports one organization and a dry run, and refuses bad arguments', async () => {
    const [t1, t2] = [tenant(), tenant()];
    for (const t of [t1, t2]) {
      await owner((c) => c.query(`INSERT INTO tenants (id, display_name, created_by, changed_by) VALUES ($1, $1, 'syn-operator', 'syn-operator') ON CONFLICT DO NOTHING`, [t]));
      const h = (await declareUpload(reports, await newReport(t, 250), { principal: 'p', sha256: HASH, contentType: 'text/x-vcf' }))!;
      await age(h.attempt.id, 3 * 86400);
    }
    const lines: string[] = [];
    const run = (args: string[]) => owner((c) => runUploads(c, args, (l) => lines.push(l)));
    expect(await run(['sweep', '--tenant', t1, '--dry-run'])).toBe(0);
    expect(lines.join('\n')).toContain(`would release: tenant=${t1} attempts=1 bytes=250 objects-kept=0`);
    expect(lines.at(-1)).toMatch(/^dry run: nothing changed\. would release 1 attempt\(s\), 250 byte\(s\) of quota, across 1 organization\(s\)/);
    lines.length = 0;
    expect(await run(['sweep'])).toBe(0);
    expect(lines.join('\n')).toContain(`released: tenant=${t1} attempts=1`);
    expect(lines.join('\n')).toContain(`released: tenant=${t2} attempts=1`);
    expect(await run(['sweep', '--grace-seconds', 'soon'])).toBe(2);
    expect(await run(['sweep', '--bogus'])).toBe(2);
    expect(await run(['clean'])).toBe(2);
  });

  it('is the same sweep the scheduled job runs: the job closes exactly what the operator command would, for its own organization only', async () => {
    const [t1, t2] = [tenant(), tenant()];
    const [r1, r2, r3] = await Promise.all([newReport(t1, 100), newReport(t1, 250), newReport(t2, 400)]);
    const [h1, h2, h3] = [
      (await declareUpload(reports, r1, { principal: 'p', sha256: HASH, contentType: 'text/x-vcf' }))!,
      (await declareUpload(reports, r2, { principal: 'p', sha256: HASH, contentType: 'text/x-vcf' }))!,
      (await declareUpload(reports, r3, { principal: 'p', sha256: HASH, contentType: 'text/x-vcf' }))!,
    ];
    await age(h1.attempt.id, 3 * 86400);
    await age(h3.attempt.id, 3 * 86400);
    // t2 is in the registry and has a job; t1 is the one swept.
    await owner(async (c) => {
      for (const t of [t1, t2]) await c.query(`INSERT INTO tenants (id, display_name, created_by, changed_by) VALUES ($1, $1, 'syn', 'syn') ON CONFLICT DO NOTHING`, [t]);
    });
    const dry = await owner((c) => sweepRegistered(c, t1, { graceSeconds: 86400, dryRun: true })); // what the operator command would close
    const jobId = (
      await owner((c) =>
        c.query(
          `INSERT INTO jobs (tenant_id, type, payload, idempotency_key, requested_by, state, attempts, locked_by, lease_until, started_at)
      VALUES ($1, 'uploads.sweep', '{}', 'sweep-parity', 'system:scheduler', 'running', 1, 'w1', now() + interval '5 minutes', now()) RETURNING id`,
          [t1],
        ),
      )
    ).rows[0].id as string;
    const viaJob = await withAdmin(db.workerUrl, async (c) => (await c.query('SELECT * FROM job_uploads_sweep($1, $2)', [jobId, 'w1'])).rows[0]);
    expect({ released: viaJob.released, releasedBytes: Number(viaJob.released_bytes), objectsKept: viaJob.objects_kept }).toEqual({
      released: dry.released,
      releasedBytes: dry.releasedBytes,
      objectsKept: dry.objectsKept,
    });
    expect(await stateOf(h1.attempt.id)).toBe('cleaned');
    expect(await stateOf(h2.attempt.id)).toBe('declared');
    expect(await stateOf(h3.attempt.id)).toBe('declared'); // another organization's old attempt is not this job's
    expect(await reserved(t2)).toBe(400);
    // A job that does not hold the sweep, or that is not a sweep, is refused.
    await expect(withAdmin(db.workerUrl, (c) => c.query('SELECT * FROM job_uploads_sweep($1, $2)', [jobId, 'someone-else']))).rejects.toThrow(/does not hold that job/);
  });

  it("computes an organization's scope id exactly as the application does", async () => {
    const ids = ['syn-a', 'acme-pharmacy', 'x', 'a'.repeat(63), 'tenant-ünï', '', 'with space'];
    for (const t of ids) {
      expect([t, (await owner((c) => c.query('SELECT uploads_organization_run_id($1) AS id', [t]))).rows[0].id]).toEqual([t, organizationRunId(t)]);
    }
  });
});
