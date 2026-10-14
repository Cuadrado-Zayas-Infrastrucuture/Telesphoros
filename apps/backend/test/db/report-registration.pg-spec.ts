import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { Database } from '../../src/db/database';
import { migrateDown, migrateUp } from '../../src/db/migrator';
import type { ReportRecord } from '../../src/storage/records';
import { PostgresReportsRepository } from '../../src/storage/postgres/reports.repository';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { assertSchemaAcceptance } from '../helpers/schema-acceptance';

let pg: EphemeralDatabase;
let first: Database;
let second: Database;
let reports: PostgresReportsRepository;
let otherPool: PostgresReportsRepository;
const tenant = 'syn-registration';
const actor = 'syn-creator';
const hash = 'a'.repeat(64);
beforeAll(async () => {
  pg = await createEphemeralDatabase();
  first = new Database({ url: pg.appUrl, ssl: 'disable' });
  second = new Database({ url: pg.appUrl, ssl: 'disable' });
  reports = new PostgresReportsRepository(first);
  otherPool = new PostgresReportsRepository(second);
});
afterAll(async () => { await first?.onModuleDestroy(); await second?.onModuleDestroy(); await pg?.drop(); });

async function record(): Promise<ReportRecord> {
  const patient = await first.withTenant(tenant, c => c.query(`INSERT INTO patients (tenant_id, created_by, label)
    VALUES ($1, $2, $3) RETURNING id`, [tenant, actor, `SYN-${randomUUID()}`]));
  const now = new Date().toISOString();
  return { id: randomUUID(), tenantId: tenant, createdBy: actor, patientId: patient.rows[0].id,
    type: 'vcf', filename: 'synthetic.vcf', sizeBytes: 100, status: 'received', createdAt: now, updatedAt: now,
    creationRequestId: randomUUID(), creationRequestHash: hash };
}

it('deduplicates concurrent creates across independent restricted-role pools', async () => {
  const input = await record();
  const results = await Promise.all(Array.from({ length: 16 }, (_, index) =>
    (index % 2 ? reports : otherPool).insertOrReplay({ ...input, id: randomUUID() })));
  expect(new Set(results.map(row => row.id)).size).toBe(1);
  const rows = await first.withTenant(tenant, c => c.query(`SELECT id FROM reports
    WHERE tenant_id=$1 AND created_by=$2 AND creation_request_id=$3`, [tenant, actor, input.creationRequestId]));
  expect(rows.rows).toEqual([{ id: results[0]!.id }]);
  await expect(reports.insert({ ...input, id: randomUUID() })).rejects.toMatchObject({ constraint: 'reports_creation_request_uq' });
  expect((await reports.insertOrReplay(input)).id).toBe(results[0]!.id);
});

it('admits one winner and rejects a different original payload when requests race', async () => {
  const input = await record();
  const changed = { ...input, id: randomUUID(), filename: 'different.vcf', creationRequestHash: 'b'.repeat(64) };
  const results = await Promise.allSettled([reports.insertOrReplay(input), otherPool.insertOrReplay(changed)]);
  const won = results.filter(result => result.status === 'fulfilled');
  const lost = results.filter(result => result.status === 'rejected');
  expect(won).toHaveLength(1); expect(lost).toHaveLength(1);
  expect(lost[0]).toMatchObject({ reason: { constraint: 'reports_creation_request_uq' } });
  if (won[0]!.status !== 'fulfilled') throw new Error('Expected one winning registration');
  const original = won[0]!.value.creationRequestHash === hash ? input : changed;
  expect((await reports.insertOrReplay(original)).id).toBe(won[0]!.value.id);
});

it('retains retry identity after pool recreation, correction and soft deletion', async () => {
  const input = await record();
  const created = await reports.insertOrReplay(input);
  const fresh = new Database({ url: pg.appUrl, ssl: 'disable' });
  try {
    const repository = new PostgresReportsRepository(fresh);
    await repository.update({ ...created, filename: 'corrected.vcf' });
    expect(await repository.insertOrReplay(input)).toMatchObject({ id: created.id, filename: 'corrected.vcf', creationRequestHash: hash });
    await repository.delete(tenant, created.id);
    await expect(repository.insertOrReplay(input)).rejects.toMatchObject({ constraint: 'reports_creation_request_uq' });
    expect(await repository.findById(tenant, created.id)).toBeUndefined();
    expect((await repository.insertOrReplay({ ...input, id: randomUUID(), creationRequestId: randomUUID() })).id).not.toBe(created.id);
  } finally { await fresh.onModuleDestroy(); }
});

it('enforces pair validity and immutable identity in PostgreSQL; ordinary metadata correction still succeeds', async () => {
  const input = await record(); await reports.insertOrReplay(input);
  for (const [column, value] of [['creation_request_id', randomUUID()], ['creation_request_hash', 'b'.repeat(64)]] as const) {
    await expect(first.withTenant(tenant, c => c.query(`UPDATE reports SET ${column}=$1 WHERE id=$2 AND tenant_id=$3`,
      [value, input.id, tenant]))).rejects.toMatchObject({ code: '23000' });
  }
  for (const change of [{ creationRequestHash: null }, { creationRequestHash: 'invalid' }, { creationRequestId: null }]) {
    await expect(reports.insert({ ...input, ...change, id: randomUUID() })).rejects.toMatchObject({ code: '23514', constraint: 'reports_creation_request_pair' });
  }
  const legacy = { ...input, id: randomUUID(), creationRequestId: null, creationRequestHash: null };
  await reports.insert(legacy);
  await expect(first.withTenant(tenant, c => c.query(`UPDATE reports SET creation_request_id=$1, creation_request_hash=$2
    WHERE id=$3 AND tenant_id=$4`, [randomUUID(), hash, legacy.id, tenant]))).rejects.toMatchObject({ code: '23000' });
  await reports.update({ ...input, filename: 'corrected.vcf' });
  expect(await reports.insertOrReplay(input)).toMatchObject({ filename: 'corrected.vcf', creationRequestHash: hash });
});

it('upgrades legacy rows unchanged and guards populated rollback before explicit fixture-only opt-in', async () => {
  const disposable = await createEphemeralDatabase();
  try {
    await withAdmin(disposable.adminUrl, async c => {
      expect(await migrateDown(c, 3)).toEqual(['0016', '0015', '0014']);
      const p = (await c.query(`INSERT INTO patients (tenant_id, created_by, label) VALUES ($1,$2,'SYN-LEGACY') RETURNING id`, [tenant, actor])).rows[0].id;
      const row = (await c.query(`INSERT INTO reports (tenant_id,created_by,patient_id,type,original_filename,size_bytes)
        VALUES ($1,$2,$3,'vcf','legacy.vcf',100) RETURNING *`, [tenant, actor, p])).rows[0];
      expect(await migrateUp(c)).toEqual(['0014', '0015', '0016']);
      const upgraded = (await c.query('SELECT * FROM reports WHERE id=$1 AND tenant_id=$2', [row.id, tenant])).rows[0];
      expect(upgraded).toEqual({ ...row, creation_request_id: null, creation_request_hash: null, upload_revision: expect.any(String) });
      // Keep the 0014 rollback guard under test at its own version boundary.
      expect(await migrateDown(c,2)).toEqual(['0016', '0015']);
      // The only data loss here is retry metadata in this helper-owned disposable database.
      const key = randomUUID();
      await c.query(`INSERT INTO reports (tenant_id,created_by,patient_id,type,original_filename,size_bytes,creation_request_id,creation_request_hash)
        VALUES ($1,$2,$3,'vcf','keyed.vcf',100,$4,$5)`, [tenant, actor, p, key, hash]);
      for (const setting of ['', 'true', 'YES']) {
        await c.query("SELECT set_config('telesphoros.allow_report_retry_drop',$1,false)", [setting]);
        await expect(migrateDown(c, 1)).rejects.toThrow(/Refusing to drop populated/);
      }
      expect((await c.query('SELECT creation_request_hash FROM reports WHERE tenant_id=$1 AND created_by=$2 AND creation_request_id=$3', [tenant, actor, key])).rows).toEqual([{ creation_request_hash: hash }]);
      await c.query("SELECT set_config('telesphoros.allow_report_retry_drop','yes',false)");
      expect(await migrateDown(c, 1)).toEqual(['0014']);
      expect((await c.query('SELECT count(*)::int AS n FROM reports WHERE tenant_id=$1', [tenant])).rows).toEqual([{ n: 2 }]);
      expect(await migrateUp(c)).toEqual(['0014', '0015', '0016']);
      await assertSchemaAcceptance(c);
    });
  } finally { await disposable.drop(); }
});

it('fails migration on bounded lock contention without a partial upgrade, then succeeds after release', async () => {
  const disposable = await createEphemeralDatabase();
  const blocker = new Client({ connectionString: disposable.adminUrl });
  try {
    await withAdmin(disposable.adminUrl, c => migrateDown(c, 3));
    await blocker.connect(); await blocker.query('BEGIN'); await blocker.query('LOCK TABLE reports IN ACCESS EXCLUSIVE MODE');
    await expect(withAdmin(disposable.adminUrl, c => migrateUp(c))).rejects.toThrow(/lock timeout/);
    await blocker.query('ROLLBACK');
    await withAdmin(disposable.adminUrl, async c => {
      expect((await c.query("SELECT 1 FROM information_schema.columns WHERE table_name='reports' AND column_name='creation_request_id'")).rows).toEqual([]);
      expect(await migrateUp(c)).toEqual(['0014', '0015', '0016']);
      await assertSchemaAcceptance(c);
    });
  } finally { await blocker.end(); await disposable.drop(); }
});

it('detects an injected uniqueness defect and an injected disabled identity guard, with restored controls', async () => {
  const input = await record(); await reports.insertOrReplay(input);
  await withAdmin(pg.adminUrl, async c => {
    await assertSchemaAcceptance(c);
    await c.query('BEGIN');
    try {
      await c.query('ALTER TABLE reports DROP CONSTRAINT reports_creation_request_uq');
      await expect(assertSchemaAcceptance(c)).rejects.toThrow();
    } finally { await c.query('ROLLBACK'); }
    await assertSchemaAcceptance(c);
    const attempt = () => expect(c.query('UPDATE reports SET creation_request_hash=$1 WHERE id=$2 AND tenant_id=$3', ['b'.repeat(64), input.id, tenant]))
      .rejects.toMatchObject({ code: '23000' });
    await attempt();
    await c.query('BEGIN');
    try {
      await c.query('ALTER TABLE reports DISABLE TRIGGER reports_creation_request_guard');
      await expect(attempt()).rejects.toThrow(/promise resolved/i);
    } finally { await c.query('ROLLBACK'); }
    await attempt();
    expect((await reports.insertOrReplay(input)).creationRequestHash).toBe(hash);
  });
});
