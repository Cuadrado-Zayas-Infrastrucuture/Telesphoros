import { readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createBackup } from '../../src/db/backup';
import { generateKeyFile, readKeyFile } from '../../src/db/backup-crypto';
import { type UploadTarget } from '../../src/db/offsite';
import { restoreFromRemote } from '../../src/db/restore-remote';
import { adminUrl, createEphemeralDatabase, type EphemeralDatabase, serializeRestoreSuites, withAdmin } from '../helpers/database';
import { cleanupScratch, clientFor, emulator, newBucket, S3_ENDPOINT, tempDir } from '../helpers/offsite-fixtures';
import { type Gateway, type Op, startGateway } from '../helpers/provider-gateway';

// Counts shared state (throwaway databases, temp dirs): must not overlap another restoring suite.
serializeRestoreSuites();
// Each test dumps a database, uploads it over the S3 protocol and restores it: the 5 s default fails on a loaded runner.
jest.setTimeout(30_000);

// This file counts `restore-*` folders in os.tmpdir() before and after a restore, and the restore deletes stale ones there. Another
// process using the same temp dir (a neighbouring loop's restore specs, test/cleanup.spec.ts) would change the count or lose its own
// folders, so the file gets a private temp root. Setting process.env.TMPDIR does not work: jest gives each test file a copy of
// process.env, and os.tmpdir() reads the real one.
jest.mock('node:os', () => {
  const actual = jest.requireActual<typeof import('node:os')>('node:os');
  const { mkdtempSync } = jest.requireActual<typeof import('node:fs')>('node:fs');
  const { join } = jest.requireActual<typeof import('node:path')>('node:path');
  let root: string | undefined; // made on first use, so a skipped file leaves nothing behind
  return { ...actual, tmpdir: () => (root ??= mkdtempSync(join(actual.tmpdir(), 'offsite-restore-spec-'))) };
});
const PRIVATE_TMP = 'offsite-restore-spec-';
const removePrivateTmp = () => {
  if (basename(tmpdir()).startsWith(PRIVATE_TMP)) rmSync(tmpdir(), { recursive: true, force: true }); // never the shared one
};

/**
 * The whole chain: a real database backed up with the real code, copied to a "second provider", then restored FROM that
 * provider with a read-only key. Needs both the database tier and the S3 tier (TEST_DATABASE_URL and TEST_S3_ENDPOINT).
 */
const both = Boolean(process.env.TEST_S3_ENDPOINT);
if (!both) process.stderr.write('[jest] NOT RUNNING: test/db/offsite-restore (also needs TEST_S3_ENDPOINT)\n');
const suite = both ? describe : describe.skip;

const UP = 'AKUPLOADONLY';
const RD = 'AKREADONLY';
const PERMISSIONS: Record<string, Op[]> = { [UP]: ['put'], [RD]: ['get', 'list'] };

const dbs: EphemeralDatabase[] = [];
const gateways: Gateway[] = [];
afterAll(async () => {
  await Promise.all(dbs.map((d) => d.drop()));
  await Promise.all(gateways.map((g) => g.close()));
  cleanupScratch();
  removePrivateTmp();
});

async function seeded(): Promise<EphemeralDatabase> {
  const db = await createEphemeralDatabase();
  dbs.push(db);
  await withAdmin(db.adminUrl, async (c) => {
    for (const tenant of ['alice', 'bob']) await c.query(`INSERT INTO patients (tenant_id, created_by, label) VALUES ($1, $1, $2)`, [tenant, `SYN-${tenant}-1`]);
  });
  return db;
}

async function setup() {
  const g = await startGateway(S3_ENDPOINT, { keys: PERMISSIONS, strict: true });
  gateways.push(g);
  const bucket = await newBucket();
  const keyFile = join(tempDir(), 'backup.key');
  await generateKeyFile(keyFile);
  const upload: UploadTarget = { client: clientFor(g.url, UP), bucket, prefix: 'nightly', lockMode: 'GOVERNANCE', retainDays: 30 };
  return { g, bucket, keyFile, upload, read: clientFor(g.url, RD) };
}

const restoreDirs = () => readdirSync(tmpdir()).filter((n) => /^restore-(dl-)?[A-Za-z0-9]{6}$/.test(n)).length;
const throwaways = async () => (await withAdmin(adminUrl(), (c) => c.query(`SELECT datname FROM pg_database WHERE datname LIKE 'restore_check_%'`))).rows.length;
const names = (checks: { name: string; ok: boolean }[]) => checks.map((c) => `${c.ok ? 'PASS' : 'FAIL'} ${c.name}`);

suite('restore from the second provider', () => {
  it('runs in its own temp root, not the one shared with other processes', () => {
    expect(basename(tmpdir())).toMatch(/^offsite-restore-spec-/);
  });

  it('backs up, uploads with the upload-only key, and restores from the remote with the read-only key, verified completely', async () => {
    const db = await seeded();
    const { g, bucket, keyFile, upload, read } = await setup();
    const result = await createBackup({ adminUrl: db.adminUrl, destDir: tempDir(), keyFile, upload });
    expect(result.upload!.keys).toHaveLength(2);
    expect(new Set(g.requests.map((r) => r.accessKeyId))).toEqual(new Set([UP]));

    const before = { dirs: restoreDirs(), dbs: await throwaways() };
    const name = result.upload!.keys[0]!.split('/')[1]!;
    const report = await restoreFromRemote({ adminUrl: adminUrl(), keyFile, client: read, location: { bucket, prefix: 'nightly', backup: name } });
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(names(report.checks).slice(0, 3)).toEqual(['PASS download', 'PASS manifest valid', 'PASS manifest signature']);
    expect(report.ok).toBe(true);
    expect({ dirs: restoreDirs(), dbs: await throwaways() }).toEqual(before); // downloaded copy and throwaway database are gone

    // The read key restored it; it did not (and could not) write anything.
    expect(g.requests.filter((r) => r.accessKeyId === RD).every((r) => r.op === 'get' || r.op === 'list')).toBe(true);
  });

  it('--latest picks the newest complete backup', async () => {
    const db = await seeded();
    const { bucket, keyFile, upload, read } = await setup();
    const first = await createBackup({ adminUrl: db.adminUrl, destDir: tempDir(), keyFile, upload });
    await new Promise((resolve) => setTimeout(resolve, 20)); // distinct timestamps
    const second = await createBackup({ adminUrl: db.adminUrl, destDir: tempDir(), keyFile, upload });
    const report = await restoreFromRemote({ adminUrl: adminUrl(), keyFile, client: read, location: { bucket, prefix: 'nightly' }, latest: true });
    expect(report.ok).toBe(true);
    expect(report.checks[0]!.detail).toContain(second.upload!.keys[0]!.split('/')[1]!);
    expect(report.checks[0]!.detail).not.toContain(first.upload!.keys[0]!.split('/')[1]!);

    const noLatest = await restoreFromRemote({ adminUrl: adminUrl(), keyFile, client: read, location: { bucket, prefix: 'nightly' } });
    expect(noLatest.ok).toBe(false);
    expect(noLatest.checks[0]).toMatchObject({ name: 'download', ok: false, detail: expect.stringMatching(/--latest/) });
    const empty = await restoreFromRemote({ adminUrl: adminUrl(), keyFile, client: read, location: { bucket, prefix: 'nothing-here' }, latest: true });
    expect(empty.ok).toBe(false);
  });

  it('--remove-local leaves nothing on the backup host, and the backup is still restorable from the remote', async () => {
    const db = await seeded();
    const { bucket, keyFile, upload, read } = await setup();
    const dest = tempDir();
    const result = await createBackup({ adminUrl: db.adminUrl, destDir: dest, keyFile, upload, removeLocalAfterUpload: true });
    expect(result.localRemoved).toBe(true);
    expect(readdirSync(dest)).toEqual([]);
    expect((await restoreFromRemote({ adminUrl: adminUrl(), keyFile, client: read, location: { bucket, prefix: 'nightly' }, latest: true })).ok).toBe(true);
  });

  it('keeps the local copy when the upload fails (and says so by throwing)', async () => {
    const db = await seeded();
    const { g, keyFile, upload } = await setup();
    const dest = tempDir();
    const noLockBucket = await newBucket({ lock: false });
    await expect(createBackup({ adminUrl: db.adminUrl, destDir: dest, keyFile, upload: { ...upload, bucket: noLockBucket }, removeLocalAfterUpload: true })).rejects.toMatchObject({ name: 'InvalidRequest' });
    expect(readdirSync(dest)).toHaveLength(1); // the only copy is not deleted
    expect(g.requests.filter((r) => r.op === 'put' && r.status === 200)).toHaveLength(0);
  });

  it('refuses to upload an unencrypted backup, before dumping anything', async () => {
    const db = await seeded();
    const { g, upload } = await setup();
    const dest = tempDir();
    await expect(createBackup({ adminUrl: db.adminUrl, destDir: dest, upload })).rejects.toThrow(/needs --key-file/);
    expect(readdirSync(dest)).toEqual([]);
    expect(g.requests).toHaveLength(0);
  });

  describe('the remote is not trusted', () => {
    const uploaded = async () => {
      const db = await seeded();
      const env = await setup();
      const result = await createBackup({ adminUrl: db.adminUrl, destDir: tempDir(), keyFile: env.keyFile, upload: env.upload });
      const name = result.upload!.keys[0]!.split('/')[1]!;
      const restore = (keyFile = env.keyFile) => restoreFromRemote({ adminUrl: adminUrl(), keyFile, client: env.read, location: { bucket: env.bucket, prefix: 'nightly', backup: name } });
      const key = (file: string) => `nightly/${name}/${file}`;
      return { ...env, name, restore, key };
    };
    const get = async (bucket: string, key: string) => Buffer.from(await (await emulator().send(new GetObjectCommand({ Bucket: bucket, Key: key }))).Body!.transformToByteArray());
    const put = (bucket: string, key: string, body: Buffer | string) => emulator().send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));

    it('a provider that alters the manifest is caught by the signature, before the dump is used', async () => {
      const u = await uploaded();
      const manifest = JSON.parse((await get(u.bucket, u.key('manifest.json'))).toString());
      manifest.tables.patients.rows += 1;
      await put(u.bucket, u.key('manifest.json'), JSON.stringify(manifest));
      const report = await u.restore();
      expect(report.ok).toBe(false);
      expect(report.checks.at(-1)).toMatchObject({ name: 'manifest signature', ok: false });
      expect(report.checks.some((c) => c.name === 'pg_restore')).toBe(false);
    });

    it('a provider that alters the dump is caught (the size, or the authentication, whichever sees it first)', async () => {
      const u = await uploaded();
      const dump = await get(u.bucket, u.key('db.dump.enc'));
      const flipped = Buffer.from(dump);
      flipped[Math.floor(flipped.length / 2)] ^= 1; // same size, one bit
      await put(u.bucket, u.key('db.dump.enc'), flipped);
      const report = await u.restore();
      expect(report.ok).toBe(false);
      expect(report.checks.at(-1)).toMatchObject({ name: 'backup file checksum', ok: false });

      await put(u.bucket, u.key('db.dump.enc'), dump.subarray(0, dump.length - 100));
      const truncated = await u.restore();
      expect(truncated.ok).toBe(false);
      expect(truncated.checks.at(-1)).toMatchObject({ name: 'download', ok: false, detail: expect.stringMatching(/shorter/) });
    });

    it('the wrong key cannot restore, and says so without revealing anything', async () => {
      const u = await uploaded();
      const wrong = join(tempDir(), 'wrong.key');
      await generateKeyFile(wrong);
      const report = await u.restore(wrong);
      expect(report.ok).toBe(false);
      expect(report.checks.at(-1)).toMatchObject({ name: 'manifest signature', ok: false, detail: expect.stringMatching(/different key/) });
      const secret = (await readKeyFile(wrong)).toString('hex');
      expect(JSON.stringify(report)).not.toContain(secret);
    });
  });
});
