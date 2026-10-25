import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CreateBucketCommand, PutObjectLockConfigurationCommand, S3Client } from '@aws-sdk/client-s3';
import { sha256File } from '../../src/db/backup';
import { encryptFile, manifestMac } from '../../src/db/backup-crypto';
import type { BackupManifestV2 } from '../../src/db/backup-manifest';
import { createOffsiteClient, type OffsiteSettings } from '../../src/db/offsite';

export const S3_ENDPOINT = process.env.TEST_S3_ENDPOINT ?? '';

const scratch: string[] = [];
export const cleanupScratch = () => scratch.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true }));
export const tempDir = (prefix = 'offsite-test-') => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
};

/** Talks to the emulator directly, with no gateway: the "provider's own console", used to create and tamper with buckets. */
export const emulator = () =>
  new S3Client({ region: 'us-east-1', endpoint: S3_ENDPOINT, forcePathStyle: true, credentials: { accessKeyId: 'console', secretAccessKey: 'console' } });

let bucketCounter = 0;
/** A new bucket, with Object Lock (and a default retention) unless told otherwise. */
export async function newBucket(options: { lock?: boolean; defaultDays?: number } = {}): Promise<string> {
  const bucket = `offsite-${Date.now().toString(36)}-${bucketCounter++}-${randomBytes(3).toString('hex')}`;
  const lock = options.lock ?? true;
  await emulator().send(new CreateBucketCommand({ Bucket: bucket, ObjectLockEnabledForBucket: lock }));
  if (lock && options.defaultDays) {
    await emulator().send(
      new PutObjectLockConfigurationCommand({
        Bucket: bucket,
        ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled', Rule: { DefaultRetention: { Mode: 'GOVERNANCE', Days: options.defaultDays } } },
      }),
    );
  }
  return bucket;
}

export const settingsFor = (endpoint: string, overrides: Partial<OffsiteSettings> = {}): OffsiteSettings => ({
  endpoint,
  region: 'us-east-1',
  forcePathStyle: true,
  lockMode: 'GOVERNANCE',
  retainDays: 30,
  ...overrides,
});

export const clientFor = (endpoint: string, accessKeyId: string, overrides: Partial<OffsiteSettings> = {}) =>
  createOffsiteClient(settingsFor(endpoint, overrides), { accessKeyId, secretAccessKey: `secret-of-${accessKeyId}` });

export const stampName = (when: Date) => `backup-${when.toISOString().replace(/[:.]/g, '-')}`;

export interface FakeBackup {
  dir: string;
  name: string;
  manifest: BackupManifestV2;
  plain: Buffer;
}

/** A real format 2 backup directory (encrypted with `key`, manifest signed) without needing a database. */
export async function fakeBackup(key: Buffer, options: { when?: Date; plainBytes?: number; claimBytes?: number } = {}): Promise<FakeBackup> {
  const when = options.when ?? new Date();
  const name = stampName(when);
  const dir = join(tempDir(), name);
  mkdirSync(dir, { mode: 0o700 });
  const plain = randomBytes(options.plainBytes ?? 3000);
  const plainFile = join(dir, '..', `${name}.plain`);
  writeFileSync(plainFile, plain);
  const dump = join(dir, 'db.dump.enc');
  const encryption = await encryptFile(plainFile, dump, key, { chunkLog2: 10 });
  const { statSync } = await import('node:fs');
  const unsigned: Omit<BackupManifestV2, 'mac'> = {
    formatVersion: 2,
    createdAt: when.toISOString(),
    serverVersion: '16.0',
    database: 'fake',
    migrations: [],
    tables: {},
    schema: { constraints: 0, indexes: 0, triggers: 0 },
    dump: {
      file: 'db.dump.enc',
      bytes: options.claimBytes ?? statSync(dump).size,
      sha256: await sha256File(dump),
      plaintextSha256: await sha256File(plainFile),
      encrypted: true,
      encryption,
    },
  };
  const manifest: BackupManifestV2 = { ...unsigned, mac: manifestMac(unsigned, key, encryption.salt) };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
  return { dir, name, manifest, plain };
}
