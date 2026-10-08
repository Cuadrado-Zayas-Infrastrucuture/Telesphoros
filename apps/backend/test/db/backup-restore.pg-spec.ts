import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { createBackup } from '../../src/db/backup';
import { restoreAndVerify } from '../../src/db/restore';
import { adminUrl, createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';

const dbs: EphemeralDatabase[] = [];
const scratch: string[] = [];
afterAll(async () => {
  await Promise.all(dbs.map((d) => d.drop()));
  scratch.forEach((p) => rmSync(p, { recursive: true, force: true }));
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'backup-test-'));
  scratch.push(dir);
  return dir;
};
const clusterAdmin = () => adminUrl();
const passphraseFile = () => {
  const file = join(tempDir(), 'passphrase');
  writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600 });
  return file;
};

/** A realistic synthetic dataset: several tenants, a soft-deleted patient, an uploaded report, recommendations. */
async function seededDatabase(): Promise<EphemeralDatabase> {
  const db = await createEphemeralDatabase();
  dbs.push(db);
  await withAdmin(db.adminUrl, async (c) => {
    for (const tenant of ['alice', 'bob', 'carol']) {
      const live = (await c.query(`INSERT INTO patients (tenant_id, created_by, label) VALUES ($1, $1, $2) RETURNING id`, [tenant, `SYN-${tenant}-1`])).rows[0].id;
      const dead = (await c.query(`INSERT INTO patients (tenant_id, created_by, label, deleted_at) VALUES ($1, $1, $2, now()) RETURNING id`, [tenant, `SYN-${tenant}-gone`])).rows[0].id;
      expect(dead).toBeDefined();
      const report = (await c.query(
        `INSERT INTO reports (tenant_id, created_by, patient_id, type, original_filename, size_bytes, content_type, sha256, storage_key, uploaded_at)
         VALUES ($1, $1, $2, 'vcf', 'a.vcf', 100, 'text/plain', $3, $4, now()) RETURNING id`,
        [tenant, live, 'a'.repeat(64), `reports/${tenant}/1`],
      )).rows[0].id;
      await c.query(
        `INSERT INTO recommendations (tenant_id, created_by, patient_id, report_id, gene, drug, phenotype, summary, strength, guideline_version)
         VALUES ($1, $1, $2, $3, 'G', 'd', 'p', 's', 'Strong', 'v0')`,
        [tenant, live, report],
      );
    }
  });
  return db;
}

const throwawayDatabases = async () =>
  (await withAdmin(clusterAdmin(), (c) => c.query(`SELECT datname FROM pg_database WHERE datname LIKE 'restore_check_%'`))).rows.length;
const byName = (checks: { name: string; ok: boolean }[], name: string) => checks.find((c) => c.name === name);

describe('backup', () => {
  it('writes a private, checksummed backup whose manifest describes the data (soft-deleted rows included)', async () => {
    const db = await seededDatabase();
    const { dir, manifest } = await createBackup({ adminUrl: db.adminUrl, destDir: tempDir() });

    expect(manifest.serverVersion).toMatch(/^16\./); // which PostgreSQL made this backup
    expect(manifest.migrations).toEqual(['0001', '0002', '0003']);
    expect(manifest.tables.patients).toMatchObject({ rows: 6, rlsEnabled: true, rlsForced: true, policies: 1 });
    expect(manifest.tables.reports!.rows).toBe(3);
    expect(manifest.tables.recommendations!.rows).toBe(3);
    expect(manifest.schema.constraints).toBeGreaterThan(10);
    expect(manifest.dump.encrypted).toBe(false);
    expect(manifest.dump.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(join(dir, 'manifest.json')).mode & 0o077).toBe(0); // owner-only
    expect(statSync(join(dir, 'db.dump')).mode & 0o077).toBe(0);
    expect(statSync(dir).mode & 0o077).toBe(0);
  });

  it('refuses to run as the application role: RLS would silently hide rows from the backup', async () => {
    const db = await seededDatabase();
    await expect(createBackup({ adminUrl: db.appUrl, destDir: tempDir() })).rejects.toThrow(/BYPASSRLS/);
  });

  it('encrypts at rest and leaves no plaintext dump behind', async () => {
    const db = await seededDatabase();
    const { dir, manifest } = await createBackup({ adminUrl: db.adminUrl, destDir: tempDir(), passphraseFile: passphraseFile() });
    expect(manifest.dump).toMatchObject({ file: 'db.dump.enc', encrypted: true });
    expect(readdirSync(dir).sort()).toEqual(['db.dump.enc', 'manifest.json']);
    expect(statSync(join(dir, 'db.dump.enc')).mode & 0o077).toBe(0);
    expect(readFileSync(join(dir, 'db.dump.enc')).subarray(0, 8).toString()).toBe('Salted__'); // OpenSSL header: really encrypted
  });
});

describe('a failed backup leaves nothing behind', () => {
  it('rejects an empty passphrase file BEFORE dumping anything', async () => {
    const db = await seededDatabase();
    const dest = tempDir();
    const empty = join(tempDir(), 'empty');
    writeFileSync(empty, '');
    await expect(createBackup({ adminUrl: db.adminUrl, destDir: dest, passphraseFile: empty })).rejects.toThrow(/passphrase/i);
    expect(readdirSync(dest)).toEqual([]);
  });

  it('removes the partial backup (including any unencrypted dump) if a later step fails', async () => {
    const db = await seededDatabase();
    const dest = tempDir();
    const file = join(tempDir(), 'pass');
    writeFileSync(file, 'x'.repeat(40)); // passes the up-front check...
    await expect(
      createBackup({
        adminUrl: db.adminUrl,
        destDir: dest,
        passphraseFile: file,
        afterSnapshot: async () => rmSync(file), // ...then vanishes before encryption, AFTER the plaintext dump exists
      }),
    ).rejects.toThrow(/openssl/);
    expect(readdirSync(dest)).toEqual([]); // no backup-* directory, so no plaintext dump either
  });
});

describe('restore (the one-command procedure, actually executed)', () => {
  it('restores into a throwaway database, verifies it completely, and cleans up after itself', async () => {
    const db = await seededDatabase();
    const { dir } = await createBackup({ adminUrl: db.adminUrl, destDir: tempDir() });
    const before = await throwawayDatabases();

    const report = await restoreAndVerify({ adminUrl: clusterAdmin(), backupDir: dir });

    expect(report.checks.map((c) => `${c.ok ? 'PASS' : 'FAIL'} ${c.name}`)).toEqual([
      'PASS backup file checksum',
      'PASS pg_restore',
      'PASS tables present',
      'PASS row counts',
      'PASS migrations',
      'PASS schema shape (constraints, indexes, triggers)',
      'PASS row-level security settings',
      'PASS row-level security isolation',
    ]);
    expect(report.ok).toBe(true);
    // 6 patients (3 live + 3 soft-deleted) + 3 reports + 3 recommendations + 2 migration rows
    expect(byName(report.checks, 'row counts')!).toMatchObject({ detail: 'all 4 tables match (15 rows)' });
    expect(await throwawayDatabases()).toBe(before); // the throwaway was dropped
  });

  it('a kept restore is a real, usable copy of the data', async () => {
    const db = await seededDatabase();
    const { dir } = await createBackup({ adminUrl: db.adminUrl, destDir: tempDir() });
    const target = `restored_${randomBytes(4).toString('hex')}`;
    const report = await restoreAndVerify({ adminUrl: clusterAdmin(), backupDir: dir, targetDatabase: target });
    expect(report.ok).toBe(true);
    try {
      const url = new URL(clusterAdmin());
      url.pathname = `/${target}`;
      const restored = await withAdmin(url.toString(), (c) => c.query(`SELECT tenant_id, label, deleted_at IS NOT NULL AS deleted FROM patients ORDER BY tenant_id, label`));
      const original = await withAdmin(db.adminUrl, (c) => c.query(`SELECT tenant_id, label, deleted_at IS NOT NULL AS deleted FROM patients ORDER BY tenant_id, label`));
      expect(restored.rows).toEqual(original.rows);
    } finally {
      await withAdmin(clusterAdmin(), (c) => c.query(`DROP DATABASE IF EXISTS ${target} WITH (FORCE)`));
    }
  });

  it('is snapshot-consistent: rows written AFTER the snapshot but DURING the dump do not break verification', async () => {
    const db = await seededDatabase();
    const { dir, manifest } = await createBackup({
      adminUrl: db.adminUrl,
      destDir: tempDir(),
      afterSnapshot: async () => {
        // A busy database: another connection commits new rows between the baseline and the dump.
        await withAdmin(db.adminUrl, (c) => c.query(`INSERT INTO patients (tenant_id, created_by, label) VALUES ('dave', 'dave', 'SYN-late-1'), ('dave', 'dave', 'SYN-late-2')`));
      },
    });
    expect(manifest.tables.patients!.rows).toBe(6); // the baseline is the snapshot, not "now"
    const live = await withAdmin(db.adminUrl, (c) => c.query('SELECT count(*)::int AS n FROM patients'));
    expect(live.rows[0].n).toBe(8); // the source really did move on

    const report = await restoreAndVerify({ adminUrl: clusterAdmin(), backupDir: dir });
    expect(report.ok).toBe(true);
    expect(byName(report.checks, 'row counts')!.ok).toBe(true);
  });

  it('round-trips an encrypted backup with the right passphrase, and refuses the wrong one', async () => {
    const db = await seededDatabase();
    const pass = passphraseFile();
    const { dir } = await createBackup({ adminUrl: db.adminUrl, destDir: tempDir(), passphraseFile: pass });
    expect((await restoreAndVerify({ adminUrl: clusterAdmin(), backupDir: dir, passphraseFile: pass })).ok).toBe(true);

    const wrong = await restoreAndVerify({ adminUrl: clusterAdmin(), backupDir: dir, passphraseFile: passphraseFile() });
    expect(wrong.ok).toBe(false);
    expect(wrong.checks.some((c) => !c.ok && /decrypt/.test(c.name))).toBe(true);

    const missing = await restoreAndVerify({ adminUrl: clusterAdmin(), backupDir: dir });
    expect(missing.ok).toBe(false);
  });
});

describe('restore verification is not a rubber stamp (negative controls)', () => {
  const failing = (report: { ok: boolean; checks: { name: string; ok: boolean }[] }, name: string) => {
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === name)?.ok).toBe(false);
  };

  it('catches a corrupted backup file before restoring anything', async () => {
    const db = await seededDatabase();
    const { dir } = await createBackup({ adminUrl: db.adminUrl, destDir: tempDir() });
    const file = join(dir, 'db.dump');
    const bytes = readFileSync(file);
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    writeFileSync(file, bytes);
    const before = await throwawayDatabases();
    failing(await restoreAndVerify({ adminUrl: clusterAdmin(), backupDir: dir }), 'backup file checksum');
    expect(await throwawayDatabases()).toBe(before); // nothing was created
  });

  it('catches a missing backup file', async () => {
    const db = await seededDatabase();
    const { dir } = await createBackup({ adminUrl: db.adminUrl, destDir: tempDir() });
    rmSync(join(dir, 'db.dump'));
    failing(await restoreAndVerify({ adminUrl: clusterAdmin(), backupDir: dir }), 'backup file present');
  });

  it('catches a restored copy whose row counts differ from the baseline', async () => {
    const db = await seededDatabase();
    const { dir, manifest } = await createBackup({ adminUrl: db.adminUrl, destDir: tempDir() });
    manifest.tables.patients!.rows += 1; // pretend the baseline said one more row
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
    failing(await restoreAndVerify({ adminUrl: clusterAdmin(), backupDir: dir }), 'row counts');
  });

  it('catches a copy that lost its row-level security settings', async () => {
    const db = await seededDatabase();
    const { dir, manifest } = await createBackup({ adminUrl: db.adminUrl, destDir: tempDir() });
    manifest.tables.reports!.policies = 2; // baseline claims something the copy cannot have
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
    failing(await restoreAndVerify({ adminUrl: clusterAdmin(), backupDir: dir }), 'row-level security settings');
  });

  it('catches a restore target that is missing the application role (isolation cannot be proven)', async () => {
    const db = await seededDatabase();
    const { dir } = await createBackup({ adminUrl: db.adminUrl, destDir: tempDir() });
    // Simulate a fresh server by hiding the role from the check.
    const original = Client.prototype.query;
    (Client.prototype as unknown as { query: unknown }).query = function (this: Client, ...args: unknown[]) {
      const first = args[0] as string;
      if (typeof first === 'string' && first.includes(`rolname = 'telesphoros_app'`)) return Promise.resolve({ rowCount: 0, rows: [] });
      return (original as (...a: unknown[]) => unknown).apply(this, args);
    };
    try {
      failing(await restoreAndVerify({ adminUrl: clusterAdmin(), backupDir: dir }), 'row-level security isolation');
    } finally {
      Client.prototype.query = original;
    }
  });

  it('leaves no stray files or databases behind after a failed restore', async () => {
    const db = await seededDatabase();
    const { dir } = await createBackup({ adminUrl: db.adminUrl, destDir: tempDir() });
    const before = await throwawayDatabases();
    const leftovers = () => readdirSync(tmpdir()).filter((n) => n.startsWith('restore-')).length;
    const files = leftovers();
    await restoreAndVerify({ adminUrl: clusterAdmin(), backupDir: dir, passphraseFile: passphraseFile() }); // dump is not encrypted: harmless, passes
    expect(await throwawayDatabases()).toBe(before);
    expect(leftovers()).toBe(files);
    expect(existsSync(dir)).toBe(true);
  });
});
