import { randomBytes } from 'node:crypto';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DeleteObjectCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  GetObjectLockConfigurationCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { BackupCryptoError, decryptFile, encryptFile, keyIdHex, manifestMac, readKeyFile, verifyManifestMac } from './backup-crypto';
import { sha256File } from './backup';
import type { BackupManifestV2 } from './backup-manifest';
import { makeTempDir } from './cleanup';
import { downloadBackup, latestComplete, type OffsiteSettings, OffsiteError, SINGLE_PUT_LIMIT, SINGLE_PUT_WARN, uploadBackup, type UploadTarget } from './offsite';

/**
 * `backup-check`: proves the off-site SET-UP is right, item by item, before anyone depends on it. Each finding is
 * PASS, WARN (works, but look at it), FAIL (do not rely on this), or SKIP (not checked, and why). Exit code 1 on any FAIL.
 *
 * The probes use the real credentials of each role, so "the upload key cannot read or delete" is a measured fact, not
 * a statement about how the key was meant to be set up.
 */
export type Status = 'PASS' | 'WARN' | 'FAIL' | 'SKIP';
export interface Finding {
  name: string;
  status: Status;
  detail: string;
}

export interface CheckOptions {
  keyFile: string;
  bucket: string;
  prefix: string;
  settings: OffsiteSettings;
  /** Role clients. `upload` and `read` are required; `admin` is optional (setup-time bucket inspection). */
  clients: { upload: S3Client; read: S3Client; admin?: S3Client };
  /** FAIL if the newest complete backup is older than this (monitoring). Unset: report its age only. */
  maxAgeHours?: number;
  /** Do not write a canary (daily monitoring runs freshness only). */
  skipCanary?: boolean;
  /** Retention for the canary, short so repeated setup tests do not pile up locked objects. Default 1 day. */
  canaryRetainDays?: number;
  now?: () => number;
}

type Probe = 'allowed' | 'denied' | 'inconclusive';

async function probe(operation: () => Promise<unknown>): Promise<Probe> {
  try {
    await operation();
    return 'allowed';
  } catch (error) {
    const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (e.$metadata?.httpStatusCode === 403 || ['AccessDenied', 'Forbidden', 'AllAccessDisabled'].includes(e.name ?? '')) return 'denied';
    return 'inconclusive';
  }
}

const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2)} GiB`;

export async function runBackupCheck(options: CheckOptions): Promise<Finding[]> {
  const findings: Finding[] = [];
  const add = (name: string, status: Status, detail: string) => findings.push({ name, status, detail });
  const now = options.now ?? Date.now;
  const { bucket, prefix, settings } = options;
  const keyOf = (...parts: string[]) => [prefix, ...parts].filter(Boolean).join('/');

  // 1. The key.
  let master: Buffer | undefined;
  try {
    master = await readKeyFile(options.keyFile);
    const loose = statSync(options.keyFile).mode & 0o077;
    add('key file', loose ? 'FAIL' : 'PASS', loose ? 'readable by other users on this machine: chmod 600 it' : `valid, owner-only, key id ${keyIdHex(master)}`);
  } catch (error) {
    add('key file', 'FAIL', error instanceof BackupCryptoError ? error.message : 'the key file could not be read');
  }
  if (!master) return findings;

  // 2. The bucket (setup time, needs the admin key).
  if (options.clients.admin) {
    const admin = options.clients.admin;
    if ((await probe(() => admin.send(new HeadBucketCommand({ Bucket: bucket })))) !== 'allowed') {
      add('bucket reachable', 'FAIL', 'the bucket does not exist or the admin key cannot see it');
    } else {
      add('bucket reachable', 'PASS', bucket);
      const versioning = await admin.send(new GetBucketVersioningCommand({ Bucket: bucket })).then((r) => r.Status, () => undefined);
      add('versioning', versioning === 'Enabled' ? 'PASS' : 'FAIL', versioning === 'Enabled' ? 'enabled' : `status ${versioning ?? 'unknown'}: Object Lock needs versioning`);
      const lock = await admin.send(new GetObjectLockConfigurationCommand({ Bucket: bucket })).then((r) => r.ObjectLockConfiguration, () => undefined);
      if (lock?.ObjectLockEnabled !== 'Enabled') {
        add('Object Lock', 'FAIL', 'not enabled on this bucket (it can only be enabled when the bucket is created)');
      } else {
        const rule = lock.Rule?.DefaultRetention;
        add('Object Lock', 'PASS', rule ? `enabled, default ${rule.Mode} for ${rule.Days ?? (rule.Years ?? 0) * 365} days` : 'enabled, no default retention (each upload carries its own)');
        if (rule?.Days !== undefined && rule.Days < settings.retainDays) add('default retention', 'WARN', `the bucket default (${rule.Days} days) is shorter than the ${settings.retainDays} days each upload requests; the longer one applies`);
      }
    }
  } else {
    add('bucket configuration', 'SKIP', 'no BACKUP_S3_ADMIN_* credentials; the lock is still enforced on every upload (a bucket without Object Lock refuses it)');
  }

  // 3. The canary round trip, then who can do what.
  if (options.skipCanary) {
    add('canary', 'SKIP', 'skipped by request');
  } else {
    const work = makeTempDir('restore-dl-');
    try {
      const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
      const name = `canary-${stamp}`;
      const local = join(work.path, 'upload', name);
      mkdirSync(local, { recursive: true, mode: 0o700 });
      const plain = join(work.path, 'canary.plain');
      writeFileSync(plain, `telesphoros backup canary ${randomBytes(8).toString('hex')}`, { mode: 0o600 });
      const encryption = await encryptFile(plain, join(local, 'db.dump.enc'), master);
      const unsigned: Omit<BackupManifestV2, 'mac'> = {
        formatVersion: 2,
        createdAt: new Date(now()).toISOString(),
        serverVersion: 'canary',
        database: 'canary',
        migrations: [],
        tables: {},
        schema: { constraints: 0, indexes: 0, triggers: 0 },
        dump: { file: 'db.dump.enc', bytes: statSync(join(local, 'db.dump.enc')).size, sha256: await sha256File(join(local, 'db.dump.enc')), plaintextSha256: await sha256File(plain), encrypted: true, encryption },
      };
      const manifest: BackupManifestV2 = { ...unsigned, mac: manifestMac(unsigned, master, encryption.salt) };
      writeFileSync(join(local, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });

      const canaryPrefix = keyOf('_canary');
      const upload: UploadTarget = { client: options.clients.upload, bucket, prefix: canaryPrefix, sse: settings.sse, kmsKeyId: settings.kmsKeyId, lockMode: settings.lockMode, retainDays: options.canaryRetainDays ?? 1 };
      let uploaded = false;
      try {
        await uploadBackup(local, manifest, upload, master, name);
        uploaded = true;
        add('upload key can upload', 'PASS', `canary written with ${upload.retainDays}-day ${settings.lockMode} retention (so the bucket honours Object Lock)`);
      } catch (error) {
        const e = error as { name?: string; message?: string };
        add('upload key can upload', 'FAIL', error instanceof OffsiteError ? error.message : `the upload was refused (${e.name ?? 'error'}): check the upload key, the bucket name and that the bucket has Object Lock`);
      }

      if (uploaded) {
        // The read key fetches it back and verifies it exactly as a real restore would.
        const dl = join(work.path, 'download');
        mkdirSync(dl, { mode: 0o700 });
        try {
          const fetched = await downloadBackup({ client: options.clients.read, bucket, prefix: canaryPrefix }, name, dl);
          const authentic = fetched.formatVersion === 2 && verifyManifestMac(fetched, master, fetched.dump.encryption.salt);
          await decryptFile(join(dl, fetched.dump.file), join(work.path, 'canary.out'), master);
          add('read key can read back', authentic ? 'PASS' : 'FAIL', authentic ? 'downloaded, signature verified, every chunk authenticated' : 'downloaded, but the signature does not verify');
        } catch (error) {
          add('read key can read back', 'FAIL', error instanceof BackupCryptoError || error instanceof OffsiteError ? error.message : 'the read key could not fetch the canary');
        }

        // The upload key must not be able to do anything else.
        const manifestKey = keyOf('_canary', name, 'manifest.json');
        const denied = async (ops: Record<string, () => Promise<unknown>>) => {
          const allowed: string[] = [];
          const unclear: string[] = [];
          for (const [label, op] of Object.entries(ops)) {
            const result = await probe(op);
            if (result === 'allowed') allowed.push(label);
            if (result === 'inconclusive') unclear.push(label);
          }
          return { allowed, unclear };
        };
        const up = await denied({
          list: () => options.clients.upload.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: canaryPrefix, MaxKeys: 1 })),
          read: () => options.clients.upload.send(new GetObjectCommand({ Bucket: bucket, Key: manifestKey })),
          delete: () => options.clients.upload.send(new DeleteObjectCommand({ Bucket: bucket, Key: manifestKey })),
        });
        add('upload key is upload-only', up.allowed.length ? 'FAIL' : up.unclear.length ? 'WARN' : 'PASS',
          up.allowed.length ? `the upload key can also: ${up.allowed.join(', ')}. Replace it with a key that may only put objects` : up.unclear.length ? `could not tell for: ${up.unclear.join(', ')} (unexpected answers from the provider)` : 'cannot list, read or delete');

        const probeKey = keyOf('_canary', `readonly-probe-${randomBytes(4).toString('hex')}`);
        const rd = await denied({
          write: () => options.clients.read.send(new PutObjectCommand({ Bucket: bucket, Key: probeKey, Body: Buffer.alloc(0), ContentLength: 0 })),
          delete: () => options.clients.read.send(new DeleteObjectCommand({ Bucket: bucket, Key: keyOf('_canary', name, 'db.dump.enc') })),
        });
        add('read key is read-only', rd.allowed.length ? 'FAIL' : rd.unclear.length ? 'WARN' : 'PASS',
          rd.allowed.length ? `the read key can also: ${rd.allowed.join(', ')}${rd.allowed.includes('write') ? ` (it left an empty object ${probeKey}; remove it)` : ''}. Replace it with a read-only key` : rd.unclear.length ? `could not tell for: ${rd.unclear.join(', ')}` : 'cannot write or delete');
      }
    } finally {
      work.dispose();
    }
  }

  // 4. Freshness: the newest real backup exists, is authentic, and is recent (the answer to replay and silent gaps).
  try {
    const newest = await latestComplete({ client: options.clients.read, bucket, prefix });
    if (!newest) {
      add('newest backup', options.maxAgeHours === undefined ? 'WARN' : 'FAIL', 'no complete backup found under this prefix');
    } else {
      const { manifest } = newest;
      const authentic = manifest.formatVersion === 2 && verifyManifestMac(manifest, master, manifest.dump.encryption.salt);
      add('newest backup is authentic', authentic ? 'PASS' : 'FAIL', authentic ? `${newest.name}, signed with this key` : `${newest.name}: the signature does not verify under this key (wrong key, or altered)`);
      const ageHours = (now() - Date.parse(manifest.createdAt)) / 3_600_000;
      const tooOld = options.maxAgeHours !== undefined && ageHours > options.maxAgeHours;
      add('newest backup is recent', tooOld ? 'FAIL' : 'PASS', `${ageHours.toFixed(1)} hours old${options.maxAgeHours !== undefined ? ` (limit ${options.maxAgeHours})` : ''}${newest.incompleteNewer ? `; ${newest.incompleteNewer} newer upload(s) never finished` : ''}`);
      const bytes = manifest.dump.bytes;
      add('upload size headroom', bytes >= SINGLE_PUT_LIMIT ? 'FAIL' : bytes >= SINGLE_PUT_WARN ? 'WARN' : 'PASS',
        `${gib(bytes)} of the ${gib(SINGLE_PUT_LIMIT)} single-upload limit${bytes >= SINGLE_PUT_WARN ? ': plan multipart upload now' : ''}`);
    }
  } catch (error) {
    add('newest backup', 'FAIL', `could not list the bucket with the read key (${(error as { name?: string }).name ?? 'error'})`);
  }
  return findings;
}
