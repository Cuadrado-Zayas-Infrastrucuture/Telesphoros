import { randomBytes, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from 'pg';
import { createBackup } from '../../src/db/backup';
import { Database } from '../../src/db/database';
import { MIGRATIONS_DIR, migrateUp } from '../../src/db/migrator';
import { restoreAndVerify } from '../../src/db/restore';
import { LedgerVerifier } from '../../src/ledger/verifier';
import { PostgresLedgerRecordsRepository } from '../../src/storage/postgres/ledger-records.repository';
import { adminUrl, createEphemeralDatabase, type EphemeralDatabase, serializeRestoreSuites, withAdmin } from '../helpers/database';
import { acceptanceFor, captureFor, evaluationFor, seedLabReport } from '../helpers/ledger-fixtures';

// Native migrations/dumps/restores and checkpoint cleanup share this bounded service budget.
jest.setTimeout(30_000);

// The restore's `ledger chain` check (slice 5B-3.3c): after a restore, every tenant's whole chain is walked as `telesphoros_ledger_verifier`.
// Counts shared state (throwaway databases, temp dirs): must not overlap another restoring suite. Synthetic data only.
serializeRestoreSuites();

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'ledger-restore-'));
  dirs.push(d);
  return d;
};
const withDb = (url: string, database: string) => {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
};
const restored: string[] = [];
const target = () => {
  const name = `restore_chain_${randomBytes(4).toString('hex')}`;
  restored.push(name);
  return name;
};
const sources: EphemeralDatabase[] = [];

/** A database with a populated, checkpointed ledger for one tenant; optionally damaged by someone who can bypass every trigger. */
async function populated(damage?: (c: Client, ids: { capture: string; tenantId: string }) => Promise<unknown>) {
  const pg = await createEphemeralDatabase();
  sources.push(pg);
  const database = new Database({ url: pg.appUrl, ssl: 'disable' });
  const repo = new PostgresLedgerRecordsRepository(database);
  const verifier = LedgerVerifier.connect(pg.verifierUrl);
  const tenantId = `tenant-${randomUUID()}`;
  const report = await seedLabReport(pg.adminUrl, tenantId);
  const capture = captureFor(report);
  const c = await repo.insertCapture(tenantId, report.uploader, capture);
  const a = await repo.insertAcceptance(tenantId, 'syn-reviewer', acceptanceFor(c.record.id, capture, { note: 'checked' }));
  const e = await repo.insertEvaluation(tenantId, 'syn-system', evaluationFor(report, c.record.id, a.record.id));
  await repo.insertCorrection(tenantId, 'syn-reviewer', { evaluationId: e.record.id, kind: 'retraction', reasonCode: 'input-misread' });
  await verifier.verify(tenantId, { recordCheckpoint: true });
  await verifier.close();
  await database.onModuleDestroy();
  if (damage) {
    await withAdmin(pg.adminUrl, async (client) => {
      await client.query(`SET session_replication_role = replica`);
      await damage(client, { capture: c.record.id, tenantId });
    });
  }
  const backupDir = (await createBackup({ adminUrl: pg.adminUrl, destDir: tempDir() })).dir;
  return { pg, tenantId, backupDir };
}

async function cleanupFixtures() {
  // Only this suite's registered synthetic targets, sources and scratch directories.
  for (const name of restored) await withAdmin(adminUrl(), (c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
  restored.length = 0;
  for (const pg of sources) await pg.drop();
  sources.length = 0;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
}
afterEach(cleanupFixtures);
afterAll(cleanupFixtures); // retry registered cleanup after a test or teardown failure
beforeEach(() => {
  expect(restored.length).toBe(0);
  expect(sources.length).toBe(0);
  expect(dirs.length).toBe(0);
});

const chainCheck = (report: Awaited<ReturnType<typeof restoreAndVerify>>) => report.checks.find((c) => c.name === 'ledger chain');

describe('the restore check "ledger chain"', () => {
  it('passes for a good backup, says what it walked, and writes nothing to the restored copy', async () => {
    const { pg, backupDir } = await populated();
    const name = target();
    const report = await restoreAndVerify({ allowUnauthenticated: true, adminUrl: adminUrl(), backupDir, targetDatabase: name });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(chainCheck(report)).toMatchObject({ ok: true });
    expect(chainCheck(report)!.detail).toMatch(/^1 tenant ledger\(s\), 5 events: chain, records and notes verified in full$/);
    expect(report.ok).toBe(true);

    // A throwaway restore stays a throwaway: no checkpoint (and so no event) was added by the check.
    const events = (url: string) =>
      withAdmin(url, async (c) => (await c.query(`SELECT (SELECT count(*) FROM ledger_events) AS e, (SELECT count(*) FROM ledger_checkpoints) AS k`)).rows[0]);
    expect(await events(withDb(adminUrl(), name))).toEqual(await events(pg.adminUrl));
  });

  it('is NOT ok when the chain cannot be walked to the end (too large for the limit): incomplete is never a pass', async () => {
    const { backupDir } = await populated();
    const report = await restoreAndVerify({ allowUnauthenticated: true, adminUrl: adminUrl(), backupDir, ledgerChainMaxEvents: 2 });
    expect(report.ok).toBe(false);
    expect(chainCheck(report)).toMatchObject({ ok: false });
    expect(chainCheck(report)!.detail).toBe('ledger 1 of 1 could not be walked to the end (2 events checked)');
    expect(report.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(['ledger chain']);
    // Control: the same backup with room to walk everything passes.
    expect(chainCheck(await restoreAndVerify({ allowUnauthenticated: true, adminUrl: adminUrl(), backupDir, ledgerChainMaxEvents: 5 }))).toMatchObject({ ok: true });
  });

  it('is NOT ok for a restored ledger with an edited record, names the kind and sequence number, and shows no value or tenant', async () => {
    const { backupDir, tenantId } = await populated((c, ids) => c.query(`UPDATE report_captures SET text_scalars = text_scalars + 1 WHERE id = $1`, [ids.capture]));
    const report = await restoreAndVerify({ allowUnauthenticated: true, adminUrl: adminUrl(), backupDir });
    expect(report.ok).toBe(false);
    const check = chainCheck(report)!;
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/^ledger 1 of 1 FAILED: payload-mismatch at \d+$/);
    expect(check.detail).not.toContain(tenantId);
    // Everything ELSE about the backup was faithful: only this check says the data was not the data that was protected.
    expect(report.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(['ledger chain']);
  });

  it('is NOT ok for a restored ledger with an edited event', async () => {
    const { backupDir } = await populated((c, ids) => c.query(`UPDATE ledger_events SET payload_sha256 = repeat('b', 64) WHERE tenant_id = $1 AND seq = 2`, [ids.tenantId]));
    const report = await restoreAndVerify({ allowUnauthenticated: true, adminUrl: adminUrl(), backupDir });
    expect(report.ok).toBe(false);
    expect(chainCheck(report)).toMatchObject({ ok: false });
    expect(chainCheck(report)!.detail).toMatch(/FAILED: .*record-hash-mismatch at 2/);
  });

  it('says "not applicable" for a backup from before the ledger existed, and still passes', async () => {
    const pg = await createEphemeralDatabase({ migrate: false });
    sources.push(pg);
    const older = tempDir();
    mkdirSync(older, { recursive: true });
    for (const file of readdirSync(MIGRATIONS_DIR)) if (/^000[1-4]_/.test(file)) copyFileSync(join(MIGRATIONS_DIR, file), join(older, file));
    await withAdmin(pg.adminUrl, (c) => migrateUp(c, older));
    const { dir } = await createBackup({ adminUrl: pg.adminUrl, destDir: tempDir() });
    const report = await restoreAndVerify({ allowUnauthenticated: true, adminUrl: adminUrl(), backupDir: dir });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(chainCheck(report)).toEqual({ name: 'ledger chain', ok: true, detail: 'not applicable: this backup predates the ledger' });
  });

  it('passes a backup whose ledger has no events yet, and says so', async () => {
    const pg = await createEphemeralDatabase();
    sources.push(pg);
    const { dir } = await createBackup({ adminUrl: pg.adminUrl, destDir: tempDir() });
    const report = await restoreAndVerify({ allowUnauthenticated: true, adminUrl: adminUrl(), backupDir: dir });
    expect(chainCheck(report)).toEqual({ name: 'ledger chain', ok: true, detail: 'no ledger events in this backup' });
  });
});
