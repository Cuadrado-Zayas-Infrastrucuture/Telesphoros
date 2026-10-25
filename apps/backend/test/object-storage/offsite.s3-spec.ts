import { chmodSync, readFileSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { decryptFile, generateKeyFile, readKeyFile } from '../../src/db/backup-crypto';
import {
  checkUploadSize,
  downloadBackup,
  fetchManifest,
  latestComplete,
  listBackups,
  loadCredentials,
  loadOffsiteSettings,
  normalizeEtag,
  OffsiteError,
  parseRemote,
  SINGLE_PUT_LIMIT,
  uploadBackup,
  type UploadTarget,
  withRetry,
} from '../../src/db/offsite';
import { runBackupCheck } from '../../src/db/offsite-check';
import { cleanupScratch, clientFor, emulator, fakeBackup, newBucket, S3_ENDPOINT, settingsFor, tempDir } from '../helpers/offsite-fixtures';
import { type Gateway, type Op, startGateway } from '../helpers/provider-gateway';

const UP = 'AKUPLOADONLY';
const RD = 'AKREADONLY';
const AD = 'AKADMIN';
const PERMISSIONS: Record<string, Op[]> = { [UP]: ['put'], [RD]: ['get', 'list'], [AD]: ['head-bucket', 'get-lock-config', 'get-versioning'] };
const DAY = 86_400_000;

const gateways: Gateway[] = [];
afterAll(async () => {
  await Promise.all(gateways.map((g) => g.close()));
  cleanupScratch();
});
const gateway = async (options: Partial<Parameters<typeof startGateway>[1]> = {}) => {
  const g = await startGateway(S3_ENDPOINT, { keys: PERMISSIONS, strict: true, ...options });
  gateways.push(g);
  return g;
};

let master: Buffer;
let keyPath: string;
beforeAll(async () => {
  keyPath = join(tempDir(), 'backup.key');
  await generateKeyFile(keyPath);
  master = await readKeyFile(keyPath);
});

const target = (g: Gateway, bucket: string, prefix = 'nightly', overrides: Partial<UploadTarget> = {}): UploadTarget => ({
  client: clientFor(g.url, UP),
  bucket,
  prefix,
  lockMode: 'GOVERNANCE',
  retainDays: 30,
  ...overrides,
});
const reader = (g: Gateway, bucket: string, prefix = 'nightly') => ({ client: clientFor(g.url, RD), bucket, prefix });
const objectBytes = async (bucket: string, key: string) => Buffer.from(await (await emulator().send(new GetObjectCommand({ Bucket: bucket, Key: key }))).Body!.transformToByteArray());

describe('uploading a backup to the second provider', () => {
  it('writes the dump, then the manifest last, each locked, checksummed and with no server-side encryption header', async () => {
    const g = await gateway();
    const bucket = await newBucket();
    const backup = await fakeBackup(master);
    const result = await uploadBackup(backup.dir, backup.manifest, target(g, bucket), master);

    expect(result.keys).toEqual([`nightly/${backup.name}/db.dump.enc`, `nightly/${backup.name}/manifest.json`]);
    expect(result.etagVerified).toBe(true);
    expect(await objectBytes(bucket, result.keys[0]!)).toEqual(readFileSync(join(backup.dir, 'db.dump.enc')));
    expect(await objectBytes(bucket, result.keys[1]!)).toEqual(readFileSync(join(backup.dir, 'manifest.json')));

    const puts = g.requests.filter((r) => r.op === 'put');
    expect(puts.map((r) => r.path.split('?')[0]!.split('/').pop())).toEqual(['db.dump.enc', 'manifest.json']); // the manifest is last
    for (const put of puts) {
      expect(put.status).toBe(200);
      expect(put.headers['x-amz-object-lock-mode']).toBe('GOVERNANCE');
      const until = Date.parse(String(put.headers['x-amz-object-lock-retain-until-date']));
      expect(Math.abs(until - (Date.now() + 30 * DAY))).toBeLessThan(120_000); // 30 days, per object
      expect(put.headers['content-md5']).toBeDefined();
      expect(put.headers['x-amz-server-side-encryption']).toBeUndefined(); // the file is already encrypted on our side
      expect(Object.keys(put.headers).filter((h) => h.startsWith('x-amz-checksum-') || h === 'x-amz-sdk-checksum-algorithm')).toEqual([]);
    }
  });

  it('works against a strict provider that rejects the SDK default checksum headers (and the control proves the gateway is strict)', async () => {
    const g = await gateway();
    const bucket = await newBucket();
    const backup = await fakeBackup(master);
    // Control: an SDK client left at its defaults is refused by this provider, so the test below is not vacuous.
    const defaults = new S3Client({ region: 'us-east-1', endpoint: g.url, forcePathStyle: true, credentials: { accessKeyId: UP, secretAccessKey: 's' }, maxAttempts: 1 });
    await expect(defaults.send(new PutObjectCommand({ Bucket: bucket, Key: 'x', Body: 'hello' }))).rejects.toMatchObject({ $metadata: { httpStatusCode: 400 } });
    await expect(uploadBackup(backup.dir, backup.manifest, target(g, bucket), master)).resolves.toBeDefined();
  });

  it('never sends the application\'s AWS credentials to the other provider', async () => {
    const saved = { id: process.env.AWS_ACCESS_KEY_ID, secret: process.env.AWS_SECRET_ACCESS_KEY, profile: process.env.AWS_PROFILE };
    process.env.AWS_ACCESS_KEY_ID = 'AKIAAPPLICATIONPRIMARY';
    process.env.AWS_SECRET_ACCESS_KEY = 'primary-account-secret';
    try {
      const g = await gateway();
      const bucket = await newBucket();
      const backup = await fakeBackup(master);
      await uploadBackup(backup.dir, backup.manifest, target(g, bucket), master);
      expect(g.requests.length).toBeGreaterThan(0);
      expect(new Set(g.requests.map((r) => r.accessKeyId))).toEqual(new Set([UP]));
      expect(JSON.stringify(g.requests)).not.toContain('AKIAAPPLICATIONPRIMARY');
      // And the configuration loader does not fall back to them either.
      expect(() => loadCredentials('upload', {})).toThrow(/BACKUP_S3_UPLOAD_ACCESS_KEY_ID/);
      expect(() => loadCredentials('upload', { AWS_ACCESS_KEY_ID: 'AKIAAPPLICATIONPRIMARY', AWS_SECRET_ACCESS_KEY: 'x' })).toThrow(/deliberately not used/);
    } finally {
      for (const [name, value] of [['AWS_ACCESS_KEY_ID', saved.id], ['AWS_SECRET_ACCESS_KEY', saved.secret], ['AWS_PROFILE', saved.profile]] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it('is refused by the provider when the bucket has no Object Lock, and nothing is stored', async () => {
    const g = await gateway();
    const bucket = await newBucket({ lock: false });
    const backup = await fakeBackup(master);
    await expect(uploadBackup(backup.dir, backup.manifest, target(g, bucket), master)).rejects.toMatchObject({ name: 'InvalidRequest' });
    const listed = await emulator().send(new ListObjectsV2Command({ Bucket: bucket }));
    expect(listed.KeyCount).toBe(0);
  });

  it('retries a transient provider failure with a fresh stream, but never retries a refusal', async () => {
    const g = await gateway({ failFirstPuts: 2 });
    const bucket = await newBucket();
    const backup = await fakeBackup(master);
    await uploadBackup(backup.dir, backup.manifest, target(g, bucket), master);
    expect(g.requests.filter((r) => r.op === 'put' && r.status === 503)).toHaveLength(2);
    expect(await objectBytes(bucket, `nightly/${backup.name}/db.dump.enc`)).toEqual(readFileSync(join(backup.dir, 'db.dump.enc'))); // complete, not a half-consumed stream

    const readOnly = await gateway();
    const before = readOnly.requests.length;
    await expect(uploadBackup(backup.dir, backup.manifest, { ...target(readOnly, bucket), client: clientFor(readOnly.url, RD) }, master)).rejects.toMatchObject({ name: 'AccessDenied' });
    expect(readOnly.requests.length - before).toBe(1); // asked once
    let calls = 0;
    await expect(withRetry(async () => { calls++; throw Object.assign(new Error('x'), { $metadata: { httpStatusCode: 403 } }); }, 3, 1)).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it('verifies the upload whatever the ETag looks like: quoted, upper-case, not an MD5, or wrong', async () => {
    for (const [etag, expectation] of [['as-is', 'verified'], ['upper-unquoted', 'verified'], ['not-md5', 'unverifiable'], ['wrong-md5', 'refused']] as const) {
      const g = await gateway({ etag });
      const bucket = await newBucket();
      const backup = await fakeBackup(master);
      const attempt = uploadBackup(backup.dir, backup.manifest, target(g, bucket), master);
      if (expectation === 'refused') await expect(attempt).rejects.toThrow(/different content/);
      else expect((await attempt).etagVerified).toBe(expectation === 'verified');
    }
    expect(normalizeEtag('"ABCDEF0123456789abcdef0123456789"')).toBe('abcdef0123456789abcdef0123456789');
    expect(normalizeEtag('W/"abc"')).toBe('abc');
    expect(normalizeEtag('  "abc"  ')).toBe('abc');
    expect(normalizeEtag(undefined)).toBe('');
  });

  it('refuses to upload anything that is not an encrypted, signed backup that still matches its signature', async () => {
    const g = await gateway();
    const bucket = await newBucket();
    const backup = await fakeBackup(master);
    const reject = async (manifest: unknown, key: Buffer, dir = backup.dir, message: RegExp) => {
      await expect(uploadBackup(dir, manifest as never, target(g, bucket), key)).rejects.toThrow(message);
    };
    await reject({ ...backup.manifest, formatVersion: 1, dump: { ...backup.manifest.dump, encrypted: false } }, master, backup.dir, /only encrypted, signed/);
    await reject({ ...backup.manifest, tables: { x: { rows: 1, rlsEnabled: true, rlsForced: true, policies: 1 } } }, master, backup.dir, /signature does not verify/); // edited
    await reject(backup.manifest, Buffer.from(Array.from({ length: 32 }, (_, i) => i * 3)), backup.dir, /signature does not verify/); // another key

    const damaged = await fakeBackup(master);
    const dump = join(damaged.dir, 'db.dump.enc');
    const bytes = readFileSync(dump);
    bytes[10] ^= 1;
    writeFileSync(dump, bytes); // the file changed after it was signed
    await reject(damaged.manifest, master, damaged.dir, /no longer match/);
    expect(g.requests.filter((r) => r.op === 'put')).toHaveLength(0); // nothing reached the provider
  });

  it('refuses above the single-upload limit before reading the file, and warns weeks ahead', async () => {
    const g = await gateway();
    const bucket = await newBucket();
    const huge = await fakeBackup(master);
    truncateSync(join(huge.dir, 'db.dump.enc'), SINGLE_PUT_LIMIT + 1); // a sparse file: instant, and never hashed
    await expect(uploadBackup(huge.dir, huge.manifest, target(g, bucket), master)).rejects.toThrow(/5 GiB single-upload limit/);
    expect(checkUploadSize(4 * 1024 ** 3 - 1)).toEqual([]);
    expect(checkUploadSize(4 * 1024 ** 3)).toEqual([expect.stringMatching(/4\.00 GiB.*plan multipart/)]);
    expect(checkUploadSize(SINGLE_PUT_LIMIT)).toHaveLength(1);
    expect(() => checkUploadSize(SINGLE_PUT_LIMIT + 1)).toThrow(OffsiteError);
  });
});

describe('finding and downloading backups', () => {
  it('lists backups oldest to newest and picks the newest COMPLETE one', async () => {
    const g = await gateway();
    const bucket = await newBucket();
    const when = (n: number) => new Date(Date.UTC(2026, 9, n, 3, 0, 0));
    const [a, b, c] = [await fakeBackup(master, { when: when(1) }), await fakeBackup(master, { when: when(2) }), await fakeBackup(master, { when: when(3) })];
    for (const backup of [a, b]) await uploadBackup(backup.dir, backup.manifest, target(g, bucket), master);
    // The newest upload died before its manifest went up: only the dump exists.
    await emulator().send(new PutObjectCommand({ Bucket: bucket, Key: `nightly/${c.name}/db.dump.enc`, Body: readFileSync(join(c.dir, 'db.dump.enc')) }));
    // Other things under the prefix are not backups.
    await emulator().send(new PutObjectCommand({ Bucket: bucket, Key: 'nightly/_canary/canary-x/manifest.json', Body: '{}' }));
    await emulator().send(new PutObjectCommand({ Bucket: bucket, Key: 'nightly/readme.txt', Body: 'hi' }));

    // Force real provider pagination: one common prefix/object per page, opaque tokens supplied by the emulator.
    const paginated = reader(g, bucket);
    const send = paginated.client.send.bind(paginated.client);
    const lists: ListObjectsV2Command[] = [];
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- the SDK types send's callback overload as void; the real method returns this promise
    jest.spyOn(paginated.client, 'send').mockImplementation((command) => {
      if (command instanceof ListObjectsV2Command) {
        command.input.MaxKeys = 1;
        lists.push(command);
      }
      return send(command);
    });
    expect(await listBackups(paginated)).toEqual([a.name, b.name, c.name]);
    expect(lists.length).toBeGreaterThan(1);
    expect(lists[0]!.input.ContinuationToken).toBeUndefined();
    expect(lists.slice(1).every((command) => Boolean(command.input.ContinuationToken))).toBe(true);
    expect(await latestComplete(paginated)).toMatchObject({ name: b.name, incompleteNewer: 1 });

    expect(await listBackups(reader(g, bucket))).toEqual([a.name, b.name, c.name]);
    const newest = await latestComplete(reader(g, bucket));
    expect(newest).toMatchObject({ name: b.name, incompleteNewer: 1 });
    expect(await fetchManifest(reader(g, bucket), c.name)).toBeUndefined();
    expect(await latestComplete({ ...reader(g, bucket), prefix: 'elsewhere' })).toBeUndefined();
  });

  it('downloads exactly what was uploaded, owner-only, and refuses a remote file that disagrees with its manifest', async () => {
    const g = await gateway();
    const bucket = await newBucket();
    const backup = await fakeBackup(master);
    await uploadBackup(backup.dir, backup.manifest, target(g, bucket), master);

    const dest = tempDir();
    const manifest = await downloadBackup(reader(g, bucket), backup.name, dest);
    expect(manifest.dump.file).toBe('db.dump.enc');
    expect(readFileSync(join(dest, 'db.dump.enc'))).toEqual(readFileSync(join(backup.dir, 'db.dump.enc')));
    await decryptFile(join(dest, 'db.dump.enc'), join(tempDir(), 'plain'), master);

    const original = readFileSync(join(backup.dir, 'db.dump.enc'));
    for (const [, bytes, message] of [['longer', Buffer.concat([original, Buffer.from('extra')]), /larger than its manifest/], ['shorter', original.subarray(0, original.length - 5), /shorter than its manifest/]] as const) {
      await emulator().send(new PutObjectCommand({ Bucket: bucket, Key: `nightly/${backup.name}/db.dump.enc`, Body: bytes }));
      await expect(downloadBackup(reader(g, bucket), backup.name, tempDir())).rejects.toThrow(message);
    }
  });

  it('refuses a remote manifest that names a file outside the folder or is not a valid manifest', async () => {
    const g = await gateway();
    const bucket = await newBucket();
    const backup = await fakeBackup(master);
    const good = JSON.parse(readFileSync(join(backup.dir, 'manifest.json'), 'utf8'));
    const bodies = [
      JSON.stringify({ ...good, dump: { ...good.dump, file: '../../etc/passwd' } }), // would write outside the folder
      JSON.stringify({ ...good, extra: 1 }),
      'not json at all',
    ];
    for (const body of bodies) {
      await emulator().send(new PutObjectCommand({ Bucket: bucket, Key: `nightly/${backup.name}/manifest.json`, Body: body }));
      await expect(downloadBackup(reader(g, bucket), backup.name, tempDir())).rejects.toThrow(/manifest is not valid/);
    }
  });
});

describe('backup-check: is the set-up right?', () => {
  const clients = (g: Gateway) => ({ upload: clientFor(g.url, UP), read: clientFor(g.url, RD), admin: clientFor(g.url, AD) });
  const run = (g: Gateway, bucket: string, extra: Partial<Parameters<typeof runBackupCheck>[0]> = {}) =>
    runBackupCheck({ keyFile: keyPath, bucket, prefix: 'nightly', settings: settingsFor(g.url), clients: clients(g), ...extra });
  const status = (findings: { name: string; status: string }[]) => Object.fromEntries(findings.map((f) => [f.name, f.status]));

  it('passes a correct set-up item by item, and writes the canary with a short retention (not the 30 days of a real backup)', async () => {
    const g = await gateway();
    const bucket = await newBucket({ defaultDays: 30 });
    const real = await fakeBackup(master);
    await uploadBackup(real.dir, real.manifest, target(g, bucket), master);

    const findings = await run(g, bucket, { maxAgeHours: 24 });
    expect(status(findings)).toEqual({
      'key file': 'PASS',
      'bucket reachable': 'PASS',
      versioning: 'PASS',
      'Object Lock': 'PASS',
      'upload key can upload': 'PASS',
      'read key can read back': 'PASS',
      'upload key is upload-only': 'PASS',
      'read key is read-only': 'PASS',
      'newest backup is authentic': 'PASS',
      'newest backup is recent': 'PASS',
      'upload size headroom': 'PASS',
    });
    const canaryPuts = g.requests.filter((r) => r.op === 'put' && r.path.includes('/_canary/') && r.headers['x-amz-object-lock-retain-until-date']);
    expect(canaryPuts.length).toBe(2);
    for (const put of canaryPuts) expect(Math.abs(Date.parse(String(put.headers['x-amz-object-lock-retain-until-date'])) - (Date.now() + DAY))).toBeLessThan(120_000);
    const backupPuts = g.requests.filter((r) => r.op === 'put' && r.path.includes(`/${real.name}/`));
    for (const put of backupPuts) expect(Date.parse(String(put.headers['x-amz-object-lock-retain-until-date'])) - Date.now()).toBeGreaterThan(29 * DAY);

    // The probes really were refused by the provider (not skipped): the upload key tried list/read/delete and the read key tried write/delete.
    expect(g.requests.filter((r) => r.accessKeyId === UP && r.status === 403).map((r) => r.op).sort()).toEqual(['delete', 'get', 'list']);
    expect(g.requests.filter((r) => r.accessKeyId === RD && r.status === 403).map((r) => r.op).sort()).toEqual(['delete', 'put']);
    expect(JSON.stringify(findings)).not.toContain('secret-of-'); // no credential in any output
  });

  it('FAILS when the upload key can also list, read or delete (not upload-only)', async () => {
    const g = await gateway({ keys: { ...PERMISSIONS, [UP]: ['put', 'list', 'delete'] } });
    const bucket = await newBucket();
    const findings = await run(g, bucket);
    const item = findings.find((f) => f.name === 'upload key is upload-only')!;
    expect(item.status).toBe('FAIL');
    expect(item.detail).toMatch(/also: list, delete/);
  });

  it('FAILS when the read key can also write or delete', async () => {
    const g = await gateway({ keys: { ...PERMISSIONS, [RD]: ['get', 'list', 'put', 'delete'] } });
    const bucket = await newBucket();
    const item = (await run(g, bucket)).find((f) => f.name === 'read key is read-only')!;
    expect(item.status).toBe('FAIL');
    expect(item.detail).toMatch(/also: write, delete/);
  });

  it('FAILS when the bucket has no Object Lock', async () => {
    const g = await gateway();
    const bucket = await newBucket({ lock: false });
    const s = status(await run(g, bucket));
    expect(s['Object Lock']).toBe('FAIL');
    expect(s['upload key can upload']).toBe('FAIL');
  });

  it('FAILS when the upload key or the read key is wrong or unknown to the provider', async () => {
    const g = await gateway();
    const bucket = await newBucket();
    const s = status(await run(g, bucket, { clients: { upload: clientFor(g.url, 'AKNOBODY'), read: clientFor(g.url, RD) } }));
    expect(s['upload key can upload']).toBe('FAIL');
    const t = status(await run(g, bucket, { clients: { upload: clientFor(g.url, UP), read: clientFor(g.url, 'AKNOBODY') } }));
    expect(t['read key can read back']).toBe('FAIL');
    expect(t['newest backup']).toBe('FAIL');
  });

  it('FAILS a key file that other users can read; and with an unusable key file it stops before sending anything', async () => {
    const g0 = await gateway();
    const loose = join(tempDir(), 'loose.key');
    await generateKeyFile(loose);
    chmodSync(loose, 0o644);
    expect((await run(g0, await newBucket(), { keyFile: loose })).find((f) => f.name === 'key file')!.status).toBe('FAIL');
    const g = await gateway();
    const bucket = await newBucket();
    const garbage = join(tempDir(), 'garbage.key');
    writeFileSync(garbage, 'not a key');
    const findings = await run(g, bucket, { keyFile: garbage });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ name: 'key file', status: 'FAIL' });
    expect(g.requests).toHaveLength(0); // nothing was sent to the provider with a bad key
  });

  it('catches a stale, missing, foreign or unfinished newest backup', async () => {
    const g = await gateway();
    const bucket = await newBucket();
    // Nothing there yet, and a limit is set: that is a failure, not a pass.
    expect((await run(g, bucket, { skipCanary: true, maxAgeHours: 26 })).find((f) => f.name === 'newest backup')!.status).toBe('FAIL');
    expect((await run(g, bucket, { skipCanary: true })).find((f) => f.name === 'newest backup')!.status).toBe('WARN');

    const old = await fakeBackup(master, { when: new Date(Date.now() - 3 * DAY) });
    await uploadBackup(old.dir, old.manifest, target(g, bucket), master);
    const stale = await run(g, bucket, { skipCanary: true, maxAgeHours: 26 });
    expect(stale.find((f) => f.name === 'newest backup is recent')).toMatchObject({ status: 'FAIL', detail: expect.stringMatching(/7\d\.\d hours old \(limit 26\)/) });
    expect((await run(g, bucket, { skipCanary: true, maxAgeHours: 100 })).find((f) => f.name === 'newest backup is recent')!.status).toBe('PASS');

    // A backup made with another key (or altered) is not "ours".
    const otherKey = join(tempDir(), 'other.key');
    await generateKeyFile(otherKey);
    expect((await run(g, bucket, { skipCanary: true, keyFile: otherKey })).find((f) => f.name === 'newest backup is authentic')!.status).toBe('FAIL');

    // The newest upload never finished: the older one is reported, and the gap is visible.
    const fresh = await fakeBackup(master);
    await emulator().send(new PutObjectCommand({ Bucket: bucket, Key: `nightly/${fresh.name}/db.dump.enc`, Body: 'partial' }));
    expect((await run(g, bucket, { skipCanary: true })).find((f) => f.name === 'newest backup is recent')!.detail).toMatch(/1 newer upload\(s\) never finished/);
  });

  it('warns when the newest backup is approaching the single-upload limit', async () => {
    const g = await gateway();
    const bucket = await newBucket();
    const big = await fakeBackup(master, { claimBytes: 4.5 * 1024 ** 3 });
    await emulator().send(new PutObjectCommand({ Bucket: bucket, Key: `nightly/${big.name}/manifest.json`, Body: JSON.stringify(big.manifest) }));
    const item = (await run(g, bucket, { skipCanary: true })).find((f) => f.name === 'upload size headroom')!;
    expect(item.status).toBe('WARN');
    expect(item.detail).toMatch(/4\.50 GiB.*plan multipart/);
  });

  it('daily monitoring (--skip-canary) writes nothing to the bucket', async () => {
    const g = await gateway();
    const bucket = await newBucket();
    const real = await fakeBackup(master);
    await uploadBackup(real.dir, real.manifest, target(g, bucket), master);
    const before = (await emulator().send(new ListObjectsV2Command({ Bucket: bucket }))).KeyCount;
    const findings = await run(g, bucket, { skipCanary: true, clients: { upload: clientFor(g.url, RD), read: clientFor(g.url, RD) } });
    expect(findings.find((f) => f.name === 'canary')!.status).toBe('SKIP');
    expect((await emulator().send(new ListObjectsV2Command({ Bucket: bucket }))).KeyCount).toBe(before);
    expect(g.requests.filter((r) => r.accessKeyId === RD && r.op === 'put')).toHaveLength(0);
  });

  it('skips the bucket inspection, and says so, when there is no admin key', async () => {
    const g = await gateway();
    const bucket = await newBucket();
    const findings = await run(g, bucket, { clients: { upload: clientFor(g.url, UP), read: clientFor(g.url, RD) } });
    expect(findings.find((f) => f.name === 'bucket configuration')).toMatchObject({ status: 'SKIP', detail: expect.stringMatching(/lock is still enforced/) });
  });
});

describe('configuration', () => {
  it('requires https except to this machine, and validates lock mode, retention and encryption', () => {
    expect(() => loadOffsiteSettings({ BACKUP_S3_ENDPOINT: 'http://s3.example.com' })).toThrow(/https/);
    expect(() => loadOffsiteSettings({ BACKUP_S3_ENDPOINT: 'ftp://x' })).toThrow(/https/);
    expect(() => loadOffsiteSettings({ BACKUP_S3_ENDPOINT: 'not a url' })).toThrow(/valid URL/);
    expect(loadOffsiteSettings({ BACKUP_S3_ENDPOINT: 'https://s3.example.com' }).endpoint).toBe('https://s3.example.com');
    expect(loadOffsiteSettings({ BACKUP_S3_ENDPOINT: 'http://127.0.0.1:5555' }).endpoint).toBe('http://127.0.0.1:5555');
    expect(() => loadOffsiteSettings({ BACKUP_S3_ENDPOINT: 'http://127.0.0.1.evil.com' })).toThrow(/https/);
    expect(loadOffsiteSettings({})).toMatchObject({ lockMode: 'GOVERNANCE', retainDays: 30, sse: undefined, region: 'us-east-1' });
    expect(loadOffsiteSettings({ BACKUP_LOCK_MODE: 'COMPLIANCE', BACKUP_RETAIN_DAYS: '90', BACKUP_S3_SSE: 'AES256' })).toMatchObject({ lockMode: 'COMPLIANCE', retainDays: 90, sse: 'AES256' });
    expect(loadOffsiteSettings({ BACKUP_S3_SSE: 'none' }).sse).toBeUndefined();
    for (const bad of [{ BACKUP_LOCK_MODE: 'OFF' }, { BACKUP_RETAIN_DAYS: '0' }, { BACKUP_RETAIN_DAYS: '1.5' }, { BACKUP_RETAIN_DAYS: '99999' }, { BACKUP_RETAIN_DAYS: 'abc' }, { BACKUP_S3_SSE: 'weird' }]) {
      expect(() => loadOffsiteSettings(bad)).toThrow(OffsiteError);
    }
  });

  it('reads credentials from the environment or from files, per role, and its errors never contain a value', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'id'), 'AKFROMFILE\n');
    writeFileSync(join(dir, 'secret'), 'the-secret-in-a-file\n');
    expect(loadCredentials('read', { BACKUP_S3_READ_ACCESS_KEY_ID_FILE: join(dir, 'id'), BACKUP_S3_READ_SECRET_ACCESS_KEY_FILE: join(dir, 'secret') })).toEqual({ accessKeyId: 'AKFROMFILE', secretAccessKey: 'the-secret-in-a-file' });
    expect(loadCredentials('upload', { BACKUP_S3_UPLOAD_ACCESS_KEY_ID: 'a', BACKUP_S3_UPLOAD_SECRET_ACCESS_KEY: 'b' })).toEqual({ accessKeyId: 'a', secretAccessKey: 'b' });
    // A role's key is not another role's key.
    expect(() => loadCredentials('read', { BACKUP_S3_UPLOAD_ACCESS_KEY_ID: 'a', BACKUP_S3_UPLOAD_SECRET_ACCESS_KEY: 'b' })).toThrow(/BACKUP_S3_READ_/);
    let message = '';
    try {
      loadCredentials('upload', { BACKUP_S3_UPLOAD_ACCESS_KEY_ID: 'AKSHOULDNOTAPPEAR', BACKUP_S3_UPLOAD_SECRET_ACCESS_KEY_FILE: join(dir, 'missing') });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/_FILE could not be read/);
    expect(message).not.toContain('AKSHOULDNOTAPPEAR');
    expect(message).not.toContain(dir);
  });

  it('parses remotes strictly', () => {
    expect(parseRemote('s3://bucket-1/nightly/prod')).toEqual({ bucket: 'bucket-1', prefix: 'nightly/prod', backup: undefined });
    expect(parseRemote('s3://bucket-1')).toEqual({ bucket: 'bucket-1', prefix: '', backup: undefined });
    expect(parseRemote('s3://bucket-1/nightly/backup-2026-10-08T12-38-24-671Z')).toEqual({ bucket: 'bucket-1', prefix: 'nightly', backup: 'backup-2026-10-08T12-38-24-671Z' });
    for (const bad of ['bucket/x', 'https://bucket/x', 's3://', 's3://Bucket_Upper/x', 's3://b/../x', 's3://bucket-1/a/./b']) expect(() => parseRemote(bad)).toThrow(OffsiteError);
  });
});
