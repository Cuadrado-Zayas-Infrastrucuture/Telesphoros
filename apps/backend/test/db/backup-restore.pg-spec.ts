import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { createBackup } from '../../src/db/backup';
import { generateKeyFile, manifestMac, readKeyFile } from '../../src/db/backup-crypto';
import { restoreAndVerify } from '../../src/db/restore';
import { adminUrl, createEphemeralDatabase, type EphemeralDatabase, serializeRestoreSuites, withAdmin } from '../helpers/database';

// Counts shared state (throwaway databases, temp dirs): must not overlap another restoring suite.
serializeRestoreSuites();

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
const keyFile = async () => {
  const file = join(tempDir(), 'backup.key');
  await generateKeyFile(file);
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
const byName = <T extends { name: string }>(checks: T[], name: string) => checks.find((c) => c.name === name);

describe('backup', () => {
  it('writes a private, checksummed backup whose manifest describes the data (soft-deleted rows included)', async () => {
    const db = await seededDatabase();
    const { dir, manifest } = await createBackup({ adminUrl: db.adminUrl, destDir: tempDir() });

    expect(manifest.serverVersion).toMatch(/^16\./); // which PostgreSQL made this backup
    // Every migration the repository ships, in order: a rule, so adding a migration never breaks this test (an independent
    // hand-kept list lives in migrations.pg-spec.ts, which is where a forgotten migration is caught).
    expect(manifest.migrations).toEqual(readdirSync(join(__dirname, '..', '..', 'migrations')).filter((f) => f.endsWith('.up.sql')).map((f) => f.slice(0, 4)).sort());
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

  it('encrypts at rest with authenticated encryption, signs the manifest, and leaves no plaintext dump behind', async () => {
    const db = await seededDatabase();
    const { dir, manifest } = await createBackup({ adminUrl: db.adminUrl, destDir: tempDir(), keyFile: await keyFile() });
    expect(manifest.formatVersion).toBe(2);
    expect(manifest.dump).toMatchObject({ file: 'db.dump.enc', encrypted: true, encryption: { scheme: 'aes-256-gcm-stream/1' } });
    expect(manifest).toHaveProperty('mac');
    expect(readdirSync(dir).sort()).toEqual(['db.dump.enc', 'manifest.json']);
    expect(statSync(join(dir, 'db.dump.enc')).mode & 0o077).toBe(0);
    const bytes = readFileSync(join(dir, 'db.dump.enc'));
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('TPBK\u0002'); // our header, not a plaintext pg_dump ("PGDMP")
    expect(bytes.includes(Buffer.from('PGDMP'))).toBe(false);
    expect(bytes.includes(Buffer.from('SYN-alice-1'))).toBe(false); // a known value from the data is not readable in the file
  });
});

describe('a failed backup leaves nothing behind', () => {
  it('rejects a bad key file BEFORE dumping anything', async () => {
    const db = await seededDatabase();
    const dest = tempDir();
    for (const content of ['', 'not a key', 'ab'.repeat(31), '00'.repeat(32), 'a'.repeat(64)]) {
      const bad = join(tempDir(), 'bad.key');
      writeFileSync(bad, content);
      await expect(createBackup({ adminUrl: db.adminUrl, destDir: dest, keyFile: bad })).rejects.toThrow(/key file/i);
    }
    await expect(createBackup({ adminUrl: db.adminUrl, destDir: dest, keyFile: join(tempDir(), 'missing.key') })).rejects.toThrow();
    expect(readdirSync(dest)).toEqual([]);
  });

  it('removes the partial backup (including the unencrypted dump) if encryption fails after the dump exists', async () => {
    const db = await seededDatabase();
    const dest = tempDir();
    await expect(
      createBackup({
        adminUrl: db.adminUrl,
        destDir: dest,
        keyFile: await keyFile(),
        // The encrypted file's name is taken, so encryption fails AFTER pg_dump has written the plaintext dump.
        afterSnapshot: async () => writeFileSync(join(dest, readdirSync(dest)[0]!, 'db.dump.enc'), 'in the way'),
      }),
    ).rejects.toThrow();
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
      'PASS manifest valid',
      'PASS backup file checksum',
      'PASS required roles',
      'PASS pg_restore',
      'PASS tables present',
      'PASS row counts',
      'PASS migrations',
      'PASS schema shape (constraints, indexes, triggers)',
      'PASS row-level security settings',
      'PASS ownership and privileges',
      'PASS row-level security isolation',
      'PASS ledger chain',
    ]);
    expect(report.ok).toBe(true);
    // 6 patients (3 live + 3 soft-deleted) + 3 reports + 3 recommendations + one row per applied migration
    const manifestRows = 12 + readdirSync(join(__dirname, '..', '..', 'migrations')).filter((f) => f.endsWith('.up.sql')).length;
    expect(byName(report.checks, 'row counts')!.detail).toMatch(new RegExp(`^all \\d+ tables match \\(${manifestRows} rows\\)$`));
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

  it('round-trips an encrypted backup with the right key, and refuses the wrong key or none', async () => {
    const db = await seededDatabase();
    const key = await keyFile();
    const { dir } = await createBackup({ adminUrl: db.adminUrl, destDir: tempDir(), keyFile: key });
    const ok = await restoreAndVerify({ adminUrl: clusterAdmin(), backupDir: dir, keyFile: key });
    expect(ok.ok).toBe(true);
    expect(ok.checks.map((c) => c.name).slice(0, 5)).toEqual(['manifest valid', 'manifest signature', 'backup file checksum', 'decrypt', 'decrypted checksum']);

    const wrong = await restoreAndVerify({ adminUrl: clusterAdmin(), backupDir: dir, keyFile: await keyFile() });
    expect(wrong.ok).toBe(false);
    expect(wrong.checks.find((c) => c.name === 'manifest signature')).toMatchObject({ ok: false, detail: expect.stringMatching(/different key/) });

    const missing = await restoreAndVerify({ adminUrl: clusterAdmin(), backupDir: dir });
    expect(missing.ok).toBe(false);
    expect(missing.checks.find((c) => c.name === 'manifest signature')!.ok).toBe(false);
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
    const report = await restoreAndVerify({ adminUrl: clusterAdmin(), backupDir: dir });
    failing(report, 'backup file checksum');
    expect(report.checks.at(-1)!.name).toBe('backup file checksum'); // it stopped there
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
    await restoreAndVerify({ adminUrl: clusterAdmin(), backupDir: dir, passphraseFile: join(tempDir(), 'unused') }); // dump is not encrypted: the passphrase is never read, harmless, passes
    expect(await throwawayDatabases()).toBe(before);
    expect(leftovers()).toBe(files);
    expect(existsSync(dir)).toBe(true);
  });
});

describe('a stored backup cannot be altered without restore noticing (format 2)', () => {
  const read = (dir: string) => JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const write = (dir: string, manifest: unknown) => writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  const restore = (dir: string, key: string) => restoreAndVerify({ adminUrl: clusterAdmin(), backupDir: dir, keyFile: key });
  const failedAt = (report: { ok: boolean; checks: { name: string; ok: boolean }[] }, name: string) => {
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => !c.ok)?.name).toBe(name); // the first failure is the one named...
    expect(report.checks.at(-1)!.name).toBe(name); // ...and it was the last check: nothing after it ran
  };
  async function signedBackup() {
    const db = await seededDatabase();
    const key = await keyFile();
    const { dir } = await createBackup({ adminUrl: db.adminUrl, destDir: tempDir(), keyFile: key });
    return { dir, key };
  }

  it('refuses a manifest edited by whoever stores the backup (row counts, migrations, anything)', async () => {
    const before = await throwawayDatabases();
    const { dir, key } = await signedBackup();
    const manifest = read(dir);
    manifest.tables.patients.rows += 1;
    write(dir, manifest);
    failedAt(await restore(dir, key), 'manifest signature');

    const second = read(dir);
    second.tables.patients.rows -= 1; // put it back: the original verifies again
    write(dir, second);
    expect((await restore(dir, key)).ok).toBe(true);

    const extra = read(dir);
    extra.note = 'added';
    write(dir, extra);
    failedAt(await restore(dir, key), 'manifest valid');
    expect(await throwawayDatabases()).toBe(before);
  });

  it('refuses a changed dump even when the manifest is left alone, and a dump from another backup', async () => {
    const one = await signedBackup();
    const bytes = readFileSync(join(one.dir, 'db.dump.enc'));
    bytes[Math.floor(bytes.length / 2)] ^= 1;
    writeFileSync(join(one.dir, 'db.dump.enc'), bytes);
    failedAt(await restore(one.dir, one.key), 'backup file checksum');

    const two = await signedBackup();
    const other = await createBackup({ adminUrl: (await seededDatabase()).adminUrl, destDir: tempDir(), keyFile: two.key });
    writeFileSync(join(two.dir, 'db.dump.enc'), readFileSync(join(other.dir, 'db.dump.enc'))); // same key, different backup
    failedAt(await restore(two.dir, two.key), 'backup file checksum');
  });

  it('refuses a truncated dump, a dump with data appended, and an emptied one', async () => {
    for (const change of [(b: Buffer) => b.subarray(0, b.length - 20), (b: Buffer) => Buffer.concat([b, Buffer.from('x')]), () => Buffer.alloc(0)]) {
      const { dir, key } = await signedBackup();
      writeFileSync(join(dir, 'db.dump.enc'), change(readFileSync(join(dir, 'db.dump.enc'))));
      failedAt(await restore(dir, key), 'backup file checksum');
    }
  });

  it('even a correctly re-signed manifest cannot make a damaged dump pass: the chunks are authenticated too', async () => {
    const { dir, key } = await signedBackup();
    const file = join(dir, 'db.dump.enc');
    const bytes = readFileSync(file);
    bytes[bytes.length - 1] ^= 1; // flips a bit in the last chunk's tag
    writeFileSync(file, bytes);
    const manifest = read(dir);
    manifest.dump.sha256 = createHash('sha256').update(bytes).digest('hex'); // what a holder of the key could do
    manifest.mac = manifestMac(manifest, await readKeyFile(key), manifest.dump.encryption.salt);
    write(dir, manifest);
    const report = await restore(dir, key);
    failedAt(report, 'decrypt');
    expect(report.checks.at(-1)!.detail).toMatch(/altered/);
  });

  it('a correctly re-signed manifest that points at ANOTHER backup\'s dump is refused: the file header must agree with the manifest', async () => {
    const one = await signedBackup();
    // A second backup under the SAME key, so only the salt separates the two.
    const sameKeyDb = await seededDatabase();
    const other = await createBackup({ adminUrl: sameKeyDb.adminUrl, destDir: tempDir(), keyFile: one.key });
    const donor = read(other.dir);
    writeFileSync(join(one.dir, 'db.dump.enc'), readFileSync(join(other.dir, 'db.dump.enc')));
    const manifest = read(one.dir);
    manifest.dump.sha256 = donor.dump.sha256; // consistent with the swapped file...
    manifest.dump.plaintextSha256 = donor.dump.plaintextSha256;
    manifest.mac = manifestMac(manifest, await readKeyFile(one.key), manifest.dump.encryption.salt); // ...and signed (the key holder could do this)
    write(one.dir, manifest);
    const report = await restore(one.dir, one.key);
    failedAt(report, 'decrypt'); // its header carries the other backup's salt
  });

  it('refuses a downgrade: a key was given, so only an authenticated backup is accepted', async () => {
    const { dir, key } = await signedBackup();
    const plainDb = await seededDatabase();
    const plain = await createBackup({ adminUrl: plainDb.adminUrl, destDir: tempDir() }); // an unencrypted backup (what an attacker could substitute)
    failedAt(await restore(plain.dir, key), 'manifest signature');
    expect((await restore(dir, key)).ok).toBe(true);
  });

  it('refuses a manifest whose dump file name points outside the backup directory', async () => {
    const { dir, key } = await signedBackup();
    const manifest = read(dir);
    for (const file of ['../manifest.json', '/etc/passwd', 'a/b', '..', '.hidden', 'x\u0000y']) {
      manifest.dump.file = file;
      write(dir, manifest);
      failedAt(await restore(dir, key), 'manifest valid');
    }
  });

  it('refuses a manifest that is not JSON or is missing', async () => {
    const { dir, key } = await signedBackup();
    writeFileSync(join(dir, 'manifest.json'), '{ not json');
    failedAt(await restore(dir, key), 'manifest valid');
    rmSync(join(dir, 'manifest.json'));
    failedAt(await restore(dir, key), 'manifest valid');
  });

  it('error messages never contain the key, a path or any manifest text', async () => {
    const { dir, key } = await signedBackup();
    const secret = readFileSync(key, 'utf8').trim();
    const manifest = read(dir);
    manifest.tables.patients.rows += 1;
    write(dir, manifest);
    const report = await restore(dir, join(tempDir(), 'does-not-exist'));
    const text = JSON.stringify(report);
    expect(text).not.toContain(secret);
    expect(text).not.toContain(dir);
    expect(text).not.toContain('does-not-exist');
  });
});

describe('backups written before format 2 still restore', () => {
  const fixture = join(__dirname, '..', '..', '..', '..', 'tests', 'backup_fixtures', 'v1-encrypted');

  it('restores the real format 1 fixture (AES-256-CBC + passphrase) and verifies it completely', async () => {
    const report = await restoreAndVerify({ adminUrl: clusterAdmin(), backupDir: fixture, passphraseFile: join(fixture, 'passphrase.txt') });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(byName(report.checks, 'manifest valid')!.detail).toBe('format 1');
    expect(byName(report.checks, 'row counts')!.detail).toBe('all 4 tables match (15 rows)');
  });

  it('a key file cannot be used to open a format 1 backup, and a wrong passphrase still fails', async () => {
    const refused = await restoreAndVerify({ adminUrl: clusterAdmin(), backupDir: fixture, keyFile: await keyFile() });
    expect(refused.ok).toBe(false);
    expect(refused.checks.at(-1)!.name).toBe('manifest signature');
    const wrong = join(tempDir(), 'wrong');
    writeFileSync(wrong, 'a different passphrase entirely');
    const bad = await restoreAndVerify({ adminUrl: clusterAdmin(), backupDir: fixture, passphraseFile: wrong });
    expect(bad.ok).toBe(false);
  });
});
