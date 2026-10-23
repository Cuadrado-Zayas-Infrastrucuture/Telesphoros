import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { createBackup } from '../../src/db/backup';
import { Database } from '../../src/db/database';
import { restoreAndVerify } from '../../src/db/restore';
import { LedgerVerifier } from '../../src/ledger/verifier';
import { PostgresLedgerRecordsRepository } from '../../src/storage/postgres/ledger-records.repository';
import { adminUrl, createEphemeralDatabase, type EphemeralDatabase, serializeRestoreSuites, withAdmin } from '../helpers/database';
import { acceptanceFor, captureFor, evaluationFor, seedLabReport } from '../helpers/ledger-fixtures';

// Native migrations/dumps/restores and checkpoint cleanup share this bounded service budget.
jest.setTimeout(30_000);

// Counts shared state (throwaway databases, temp dirs): must not overlap another restoring suite.
serializeRestoreSuites();

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'ledger-backup-'));
  dirs.push(d);
  return d;
};
const withDb = (url: string, database: string) => {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
};
const restored: string[] = [];
let pg: EphemeralDatabase;
let tenantId: string;
let backupDir: string;
let backupRoot: string;

beforeAll(async () => {
  pg = await createEphemeralDatabase();
  const database = new Database({ url: pg.appUrl, ssl: 'disable' });
  const repo = new PostgresLedgerRecordsRepository(database);
  const verifier = LedgerVerifier.connect(pg.verifierUrl);
  tenantId = `tenant-${randomUUID()}`;
  const report = await seedLabReport(pg.adminUrl, tenantId);
  const capture = captureFor(report);
  const c = await repo.insertCapture(tenantId, report.uploader, capture);
  const a = await repo.insertAcceptance(tenantId, 'syn-reviewer', acceptanceFor(c.record.id, capture, { note: 'checked' }));
  const e = await repo.insertEvaluation(tenantId, 'syn-system', evaluationFor(report, c.record.id, a.record.id));
  await repo.insertCorrection(tenantId, 'syn-reviewer', { evaluationId: e.record.id, kind: 'retraction', reasonCode: 'input-misread' });
  await verifier.verify(tenantId, { recordCheckpoint: true });
  await verifier.close();
  await database.onModuleDestroy();
  backupRoot = tempDir();
  backupDir = (await createBackup({ adminUrl: pg.adminUrl, destDir: backupRoot })).dir;
});
async function cleanupRestores() {
  // The shared source/backup live for the suite; only each test's copies are removed here.
  for (const name of restored) await withAdmin(adminUrl(), (c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
  restored.length = 0;
  for (const d of dirs) if (d !== backupRoot) rmSync(d, { recursive: true, force: true });
  dirs.splice(0, dirs.length, ...dirs.filter((d) => d === backupRoot));
}
afterEach(cleanupRestores);
beforeEach(() => {
  expect(restored.length).toBe(0);
  expect(dirs.filter((d) => d !== backupRoot).length).toBe(0);
});
afterAll(async () => {
  await cleanupRestores();
  await pg.drop();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

const target = () => {
  const name = `restore_ledger_${randomBytes(4).toString('hex')}`;
  restored.push(name);
  return name;
};
interface EditableManifest { privileges: { roles: string[]; ownership: string[]; grants: string[] } }
const editedCopy = (edit: (manifest: EditableManifest) => void): string => {
  // An unencrypted (format 1) manifest is a plain file: the way to hand the restore a backup that lies about its roles or owners.
  const dir = tempDir();
  const manifest = JSON.parse(readFileSync(join(backupDir, 'manifest.json'), 'utf8'));
  edit(manifest);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(join(dir, 'db.dump'), readFileSync(join(backupDir, 'db.dump')));
  return dir;
};

describe('a backup of a populated ledger', () => {
  it('records who owns and may do what, and restores it exactly', async () => {
    const manifest = JSON.parse(readFileSync(join(backupDir, 'manifest.json'), 'utf8'));
    expect(manifest.privileges.roles).toEqual(expect.arrayContaining(['telesphoros_app', 'telesphoros_ledger', 'telesphoros_ledger_verifier', 'telesphoros_redactor', 'telesphoros_ledger_operator']));
    expect(manifest.privileges.ownership).toEqual(expect.arrayContaining([
      'function:ledger_append(uuid,text,text,uuid,text,smallint)|telesphoros_ledger', 'function:redact_event_note(uuid,uuid,text)|telesphoros_redactor',
    ]));

    const name = target();
    const report = await restoreAndVerify({ allowUnauthenticated: true, adminUrl: adminUrl(), backupDir, targetDatabase: name });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.checks.map((c) => c.name)).toEqual(expect.arrayContaining(['required roles', 'ownership and privileges']));

    // The restored copy IS the ledger it was taken from: the chain verifies, with the verifier's own login, and the definer functions
    // still belong to their least-privilege owners, not to whoever ran the restore.
    const verifier = LedgerVerifier.connect(withDb(pg.verifierUrl, name));
    try {
      expect(await verifier.verify(tenantId)).toMatchObject({ status: 'ok', eventsChecked: 5 });
    } finally {
      await verifier.close();
    }
    await withAdmin(withDb(adminUrl(), name), async (c: Client) => {
      const owners = (await c.query(`SELECT proname, pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('ledger_append', 'ledger_append_internal', 'redact_event_note')`)).rows;
      expect(Object.fromEntries(owners.map((r) => [r.proname, r.owner]))).toEqual({ ledger_append: 'telesphoros_ledger', ledger_append_internal: 'telesphoros_ledger', redact_event_note: 'telesphoros_redactor' });
    });
    // And it still works: the application can append to the restored ledger, and the longer chain verifies.
    const database = new Database({ url: withDb(pg.appUrl, name), ssl: 'disable' });
    const verifier2 = LedgerVerifier.connect(withDb(pg.verifierUrl, name));
    try {
      const repo = new PostgresLedgerRecordsRepository(database);
      const extra = await seedLabReport(withDb(pg.adminUrl, name), tenantId, 'syn-uploader', 'SYN-9');
      await repo.insertCapture(tenantId, extra.uploader, captureFor(extra));
      expect(await verifier2.verify(tenantId)).toMatchObject({ status: 'ok', eventsChecked: 6 });
    } finally {
      await verifier2.close();
      await database.onModuleDestroy();
    }
  });

  it('refuses before restoring anything when a role the backup names is missing from the server', async () => {
    const dir = editedCopy((m) => m.privileges.roles.push('telesphoros_role_that_does_not_exist'));
    const report = await restoreAndVerify({ allowUnauthenticated: true, adminUrl: adminUrl(), backupDir: dir });
    expect(report.ok).toBe(false);
    const check = report.checks.find((c) => c.name === 'required roles')!;
    expect(check).toMatchObject({ ok: false });
    expect(check.detail).toContain('telesphoros_role_that_does_not_exist');
    expect(report.checks.map((c) => c.name)).not.toContain('pg_restore'); // nothing was restored
  });

  it('notices when ownership or a privilege differs from what the backup recorded', async () => {
    for (const edit of [
      (m: EditableManifest) => { m.privileges.ownership = m.privileges.ownership.map((o: string) => o.replace('ledger_append(uuid,text,text,uuid,text,smallint)|telesphoros_ledger', 'ledger_append(uuid,text,text,uuid,text,smallint)|postgres')); },
      (m: EditableManifest) => { m.privileges.grants.push('function:ledger_append_internal(uuid,text,text,uuid,text,smallint)|PUBLIC|EXECUTE'); },
      (m: EditableManifest) => { m.privileges.grants = m.privileges.grants.filter((g: string) => !g.startsWith('function:ledger_record_checkpoint')); },
    ]) {
      const report = await restoreAndVerify({ allowUnauthenticated: true, adminUrl: adminUrl(), backupDir: editedCopy(edit) });
      expect(report.ok).toBe(false);
      expect(report.checks.find((c) => c.name === 'ownership and privileges')).toMatchObject({ ok: false });
    }
  });

  it('control: an unedited copy of the same backup passes every check', async () => {
    const report = await restoreAndVerify({ allowUnauthenticated: true, adminUrl: adminUrl(), backupDir: editedCopy(() => undefined) });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
  });
});

describe('a backup taken while a tenant is contained (migration 0011)', () => {
  it('restores the incident still OPEN: a restore cannot quietly reopen the writes of a tenant under investigation', async () => {
    // Runs last in this file: it leaves an open incident behind in the source database.
    const incident = await withAdmin(pg.verifierUrl, async (c: Client) => (await c.query(`SELECT ledger_record_incident($1, 'payload-mismatch', 1::bigint, 'background')::text AS id`, [tenantId])).rows[0].id as string);
    const during = (await createBackup({ adminUrl: pg.adminUrl, destDir: tempDir() })).dir;

    const name = target();
    const report = await restoreAndVerify({ allowUnauthenticated: true, adminUrl: adminUrl(), backupDir: during, targetDatabase: name });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);

    const open = await withAdmin(withDb(adminUrl(), name), async (c: Client) => (await c.query(
      `SELECT id::text AS id FROM ledger_incidents i WHERE NOT EXISTS (SELECT 1 FROM ledger_incident_clearances c WHERE c.incident_id = i.id)`)).rows.map((r) => r.id));
    expect(open).toEqual([incident]);

    // And the restored database enforces it: the application cannot append for that tenant (a copy of the data, the same refusal).
    const database = new Database({ url: withDb(pg.appUrl, name), ssl: 'disable' });
    try {
      const repo = new PostgresLedgerRecordsRepository(database);
      const extra = await seedLabReport(withDb(pg.adminUrl, name), tenantId, 'syn-uploader', 'SYN-10');
      await expect(repo.insertCapture(tenantId, extra.uploader, captureFor(extra))).rejects.toMatchObject({ name: 'LedgerCompromisedError' });
    } finally {
      await database.onModuleDestroy();
    }
  });
});
