import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client, type ServerSideEncryption } from '@aws-sdk/client-s3';
import { verifyManifestMac } from './backup-crypto';
import { type BackupManifest, type BackupManifestV2, parseManifest } from './backup-manifest';

/**
 * The off-site copy: any S3-compatible provider, with credentials that are NOT the application's AWS credentials.
 *
 * - Settings come from BACKUP_S3_* only. The AWS default credential chain is never consulted, so the keys that run the
 *   application can never be sent to the other provider by accident.
 * - Three roles, three keys: `upload` (can only write), `read` (can only list and read, used for restore and checks),
 *   `admin` (setup time only, to inspect the bucket).
 * - Every upload carries its own Object Lock retention. A bucket without Object Lock refuses it, so the lock is
 *   enforced on every run, even with a key that cannot read the bucket's configuration.
 * - Only encrypted, signed (format 2) backups whose signature verifies are uploaded.
 */

export type LockMode = 'GOVERNANCE' | 'COMPLIANCE';
export type Role = 'upload' | 'read' | 'admin';

export const SINGLE_PUT_LIMIT = 5 * 1024 ** 3; // S3's ceiling for one PutObject
export const SINGLE_PUT_WARN = 4 * 1024 ** 3; // warn weeks before the ceiling, not at it
export const DEFAULT_RETAIN_DAYS = 30;
const MANIFEST_MAX_BYTES = 1024 * 1024;
const BACKUP_NAME = /^backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

/** Fixed, key-free messages for configuration and protocol problems. */
export class OffsiteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OffsiteError';
  }
}

/** Discovery cannot establish the newest backup from an incomplete listing. Never use its partial results. */
export class IncompleteBackupListingError extends OffsiteError {
  constructor(reason: 'missing-token' | 'page-limit') {
    super(
      reason === 'missing-token'
        ? 'Backup listing is incomplete: a truncated page has no continuation token. Recovery aborted.'
        : 'Backup listing is incomplete: the 1,000-page limit was reached with more results remaining. Recovery aborted.',
    );
    this.name = 'IncompleteBackupListingError';
  }
}

export interface OffsiteSettings {
  endpoint?: string;
  region: string;
  forcePathStyle: boolean;
  /** Left off by default: the file is already encrypted before it leaves. Only for an AWS target that insists. */
  sse?: 'aws:kms' | 'AES256';
  kmsKeyId?: string;
  lockMode: LockMode;
  retainDays: number;
}

export interface RemoteLocation {
  bucket: string;
  prefix: string;
  /** Present when the URI named one backup (…/backup-<timestamp>). */
  backup?: string;
}

export function parseRemote(uri: string): RemoteLocation {
  const match = /^s3:\/\/([a-z0-9][a-z0-9.-]{1,62})\/?(.*)$/.exec(uri);
  if (!match) throw new OffsiteError('The remote must look like s3://bucket/prefix.');
  const parts = match[2]!.split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..')) throw new OffsiteError('The remote prefix must not contain "." or ".." parts.');
  const last = parts[parts.length - 1];
  const backup = last !== undefined && BACKUP_NAME.test(last) ? last : undefined;
  return { bucket: match[1]!, prefix: (backup ? parts.slice(0, -1) : parts).join('/'), backup };
}

const keyFor = (prefix: string, ...rest: string[]) => [prefix, ...rest].filter((part) => part !== '').join('/');

// -------------------------------------------------------------------------------------------------- configuration

type Env = Record<string, string | undefined>;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** A KMS key named by its full ARN, in any partition; never a bare key id or an alias. */
const KMS_KEY_ARN = /^arn:aws[a-z-]*:kms:[a-z0-9-]+:\d{12}:key\/[a-z0-9-]+$/;

/** Reads BACKUP_S3_* settings. `overrides` are command-line values, which win. */
export function loadOffsiteSettings(env: Env = process.env, overrides: Partial<Pick<OffsiteSettings, 'lockMode' | 'retainDays' | 'sse' | 'kmsKeyId'>> = {}): OffsiteSettings {
  const endpoint = env.BACKUP_S3_ENDPOINT || undefined;
  if (endpoint) {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw new OffsiteError('BACKUP_S3_ENDPOINT is not a valid URL.');
    }
    // Backups cross the internet: plain http is allowed only to this machine (the test emulator).
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
      throw new OffsiteError('BACKUP_S3_ENDPOINT must use https (plain http is accepted only for localhost).');
    }
  }
  const lockMode = (overrides.lockMode ?? env.BACKUP_LOCK_MODE ?? 'GOVERNANCE') as string;
  if (lockMode !== 'GOVERNANCE' && lockMode !== 'COMPLIANCE') throw new OffsiteError('The lock mode must be GOVERNANCE or COMPLIANCE.');
  const retainDays = overrides.retainDays ?? (env.BACKUP_RETAIN_DAYS ? Number(env.BACKUP_RETAIN_DAYS) : DEFAULT_RETAIN_DAYS);
  if (!Number.isInteger(retainDays) || retainDays < 1 || retainDays > 3650) throw new OffsiteError('The retention must be a whole number of days from 1 to 3650.');
  const sse = overrides.sse ?? (env.BACKUP_S3_SSE && env.BACKUP_S3_SSE !== 'none' ? env.BACKUP_S3_SSE : undefined);
  if (sse !== undefined && sse !== 'aws:kms' && sse !== 'AES256') throw new OffsiteError('BACKUP_S3_SSE must be aws:kms, AES256 or none.');
  const kmsKeyId = overrides.kmsKeyId ?? (env.BACKUP_S3_KMS_KEY_ID || undefined);
  // The backups bucket policy refuses both before S3 encrypts anything (docs/verification/bucket-policy-simulation.md): aws:kms with no key id would use
  // the AWS-managed key (DenyManagedKey), and its key condition compares the full ARN (DenyOtherKey). Refused here, a backup stops before the dump.
  if (sse === 'aws:kms' && !kmsKeyId) throw new OffsiteError('BACKUP_S3_SSE=aws:kms needs BACKUP_S3_KMS_KEY_ID, the backup key, or leave both unset for the bucket default.');
  if (sse === 'aws:kms' && !KMS_KEY_ARN.test(kmsKeyId!))
    throw new OffsiteError('BACKUP_S3_KMS_KEY_ID must be the full key ARN (arn:aws:kms:<region>:<account>:key/<id>), not a key id or an alias.');
  return {
    endpoint,
    region: env.BACKUP_S3_REGION || 'us-east-1',
    forcePathStyle: env.BACKUP_S3_FORCE_PATH_STYLE === 'true',
    sse,
    kmsKeyId,
    lockMode,
    retainDays,
  };
}

export interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

function secret(env: Env, name: string): string | undefined {
  const file = env[`${name}_FILE`];
  if (file) {
    try {
      return readFileSync(file, 'utf8').trim() || undefined;
    } catch {
      throw new OffsiteError(`${name}_FILE could not be read.`);
    }
  }
  return env[name] || undefined;
}

/** Credentials for one role, from BACKUP_S3_<ROLE>_ACCESS_KEY_ID / _SECRET_ACCESS_KEY (or the same names with _FILE). */
export function loadCredentials(role: Role, env: Env = process.env): Credentials {
  const base = `BACKUP_S3_${role.toUpperCase()}`;
  const accessKeyId = secret(env, `${base}_ACCESS_KEY_ID`);
  const secretAccessKey = secret(env, `${base}_SECRET_ACCESS_KEY`);
  if (!accessKeyId || !secretAccessKey) {
    throw new OffsiteError(`Set ${base}_ACCESS_KEY_ID and ${base}_SECRET_ACCESS_KEY (or the same names ending _FILE). The AWS credentials are deliberately not used.`);
  }
  return { accessKeyId, secretAccessKey };
}

/** True when the role's credentials are configured (so optional roles can be skipped without error). */
export function hasCredentials(role: Role, env: Env = process.env): boolean {
  try {
    loadCredentials(role, env);
    return true;
  } catch {
    return false;
  }
}

export function createOffsiteClient(settings: OffsiteSettings, credentials: Credentials): S3Client {
  return new S3Client({
    region: settings.region,
    endpoint: settings.endpoint,
    forcePathStyle: settings.forcePathStyle,
    credentials, // explicit: the default AWS credential chain is never consulted
    // Many S3-compatible providers reject the SDK's default checksum headers (x-amz-checksum-*, aws-chunked bodies).
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    maxAttempts: 1, // retries are ours (below): a consumed upload stream cannot be replayed by the SDK
    requestHandler: { connectionTimeout: 10_000, requestTimeout: 120_000 }, // bounded: a hung provider fails, it does not hang the job
  });
}

// ------------------------------------------------------------------------------------------------------ helpers

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function transient(error: unknown): boolean {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number }; code?: string };
  const status = e.$metadata?.httpStatusCode;
  if (status !== undefined) return status >= 500 || status === 429 || status === 408;
  return ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(e.code ?? '') || ['TimeoutError', 'RequestTimeout'].includes(e.name ?? '');
}

/** Three attempts, only for transient failures (5xx, throttling, network). Never retries a refusal such as AccessDenied. */
export async function withRetry<T>(operation: () => Promise<T>, attempts = 3, delayMs = 500): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts || !transient(error)) throw error;
      await sleep(delayMs * 2 ** (attempt - 1) * (0.75 + Math.random() / 2));
    }
  }
}

/** Providers differ: quotes or none, any case, a weak-validator prefix. Compare the bare lower-case hex. */
export function normalizeEtag(etag: string | undefined): string {
  return (etag ?? '')
    .trim()
    .replace(/^W\//i, '')
    .replace(/^"+|"+$/g, '')
    .toLowerCase();
}

async function md5OfFile(path: string): Promise<{ hex: string; base64: string }> {
  const hash = createHash('md5'); // an integrity check the protocol uses (Content-MD5, ETag), not a security control
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  const digest = hash.digest();
  return { hex: digest.toString('hex'), base64: digest.toString('base64') };
}

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

// -------------------------------------------------------------------------------------------------------- upload

/** Throws above the single-upload ceiling; returns a warning from 4 GiB so there are weeks of notice, not a failed night. */
export function checkUploadSize(size: number): string[] {
  if (size > SINGLE_PUT_LIMIT)
    throw new OffsiteError(`Refused: this backup is ${(size / 1024 ** 3).toFixed(2)} GiB, above the 5 GiB single-upload limit. Multipart upload is not built yet.`);
  return size >= SINGLE_PUT_WARN ? [`This backup is ${(size / 1024 ** 3).toFixed(2)} GiB. Off-site uploads stop working at 5 GiB (single upload); plan multipart upload now.`] : [];
}

export interface UploadTarget {
  client: S3Client;
  bucket: string;
  prefix: string;
  sse?: 'aws:kms' | 'AES256';
  kmsKeyId?: string;
  lockMode: LockMode;
  retainDays: number;
}

export interface UploadResult {
  keys: string[];
  warnings: string[];
  /** False when the provider's ETag is not an MD5 (e.g. server-side encryption); Content-MD5 was still checked by the provider. */
  etagVerified: boolean;
}

/**
 * Uploads a finished local backup. Refuses anything that is not an encrypted, signed backup whose signature verifies
 * under `masterKey` and whose files still match it. The manifest goes up last, so a backup only "exists" once complete.
 */
export async function uploadBackup(dir: string, manifest: BackupManifest, target: UploadTarget, masterKey: Buffer, name = dir.split('/').pop()!): Promise<UploadResult> {
  if (manifest.formatVersion !== 2) throw new OffsiteError('Refused: only encrypted, signed (format 2) backups are uploaded off-site.');
  if (!verifyManifestMac(manifest, masterKey, manifest.dump.encryption.salt)) throw new OffsiteError('Refused: the manifest signature does not verify under this key.');
  if (!BACKUP_NAME.test(name) && !/^canary-/.test(name)) throw new OffsiteError('Refused: unexpected backup folder name.');

  const dumpPath = `${dir}/${manifest.dump.file}`;
  const size = statSync(dumpPath).size;
  const warnings = checkUploadSize(size); // refuses before reading a multi-GiB file
  if (size !== manifest.dump.bytes || (await sha256OfFile(dumpPath)) !== manifest.dump.sha256)
    throw new OffsiteError('Refused: the backup files on disk no longer match the signed manifest.');

  const retainUntil = new Date(Date.now() + target.retainDays * 86_400_000);
  let etagVerified = true;
  const keys: string[] = [];
  const put = async (file: string) => {
    const path = `${dir}/${file}`;
    const bytes = statSync(path).size;
    const md5 = await md5OfFile(path);
    const Key = keyFor(target.prefix, name, file);
    const response = await withRetry(() =>
      target.client.send(
        new PutObjectCommand({
          Bucket: target.bucket,
          Key,
          Body: createReadStream(path), // a fresh stream for every attempt
          ContentLength: bytes,
          ContentMD5: md5.base64, // the provider verifies what it received
          ObjectLockMode: target.lockMode,
          ObjectLockRetainUntilDate: retainUntil,
          ...(target.sse ? { ServerSideEncryption: target.sse as ServerSideEncryption } : {}),
          ...(target.sse === 'aws:kms' && target.kmsKeyId ? { SSEKMSKeyId: target.kmsKeyId } : {}),
        }),
      ),
    );
    const etag = normalizeEtag(response.ETag);
    if (/^[0-9a-f]{32}$/.test(etag)) {
      if (etag !== md5.hex) throw new OffsiteError('Upload verification failed: the provider reports different content than was sent.');
    } else {
      etagVerified = false;
    }
    keys.push(Key);
  };
  await put(manifest.dump.file);
  await put('manifest.json');
  return { keys, warnings, etagVerified };
}

// ------------------------------------------------------------------------------------------ list and download

export interface ReadTarget {
  client: S3Client;
  bucket: string;
  prefix: string;
}

/** Names from a fully exhausted listing (newest last). Throws rather than returning any partial window. */
export async function listBackups(target: ReadTarget): Promise<string[]> {
  const names: string[] = [];
  const listPrefix = target.prefix ? `${target.prefix}/` : '';
  let token: string | undefined;
  for (let page = 0; page < 1000; page++) {
    const out = await withRetry(() => target.client.send(new ListObjectsV2Command({ Bucket: target.bucket, Prefix: listPrefix, Delimiter: '/', ContinuationToken: token })));
    for (const common of out.CommonPrefixes ?? []) {
      const name = (common.Prefix ?? '').replace(/\/$/, '').split('/').pop() ?? '';
      if (BACKUP_NAME.test(name)) names.push(name);
    }
    if (!out.IsTruncated) return names.sort();
    if (!out.NextContinuationToken) throw new IncompleteBackupListingError('missing-token');
    token = out.NextContinuationToken;
  }
  throw new IncompleteBackupListingError('page-limit');
}

async function readBody(body: unknown, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body as Readable) {
    total += (chunk as Buffer).length;
    if (total > limit) throw new OffsiteError('The remote manifest is larger than allowed.');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Fetches and validates one backup's manifest. Returns undefined if the backup has none (an upload that did not finish). */
export async function fetchManifest(target: ReadTarget, name: string): Promise<BackupManifest | undefined> {
  try {
    const out = await withRetry(() => target.client.send(new GetObjectCommand({ Bucket: target.bucket, Key: keyFor(target.prefix, name, 'manifest.json') })));
    return parseManifest((await readBody(out.Body, MANIFEST_MAX_BYTES)).toString('utf8'));
  } catch (error) {
    const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) return undefined;
    throw error;
  }
}

/** The newest backup that has a manifest, plus how many newer ones were incomplete. */
export async function latestComplete(target: ReadTarget): Promise<{ name: string; manifest: BackupManifest; incompleteNewer: number } | undefined> {
  const names = (await listBackups(target)).reverse();
  let incompleteNewer = 0;
  for (const name of names) {
    const manifest = await fetchManifest(target, name);
    if (manifest) return { name, manifest, incompleteNewer };
    incompleteNewer += 1;
  }
  return undefined;
}

class CapBytes extends Transform {
  private seen = 0;
  constructor(private readonly expected: number) {
    super();
  }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null, data?: Buffer) => void) {
    this.seen += chunk.length;
    // A provider (or anyone in between) cannot make us write more than the manifest says the file is.
    done(this.seen > this.expected ? new OffsiteError('The remote file is larger than its manifest says.') : null, chunk);
  }
  override _flush(done: (error?: Error | null) => void) {
    done(this.seen === this.expected ? null : new OffsiteError('The remote file is shorter than its manifest says.'));
  }
}

/** Downloads one backup into `destDir` (an existing owner-only folder) so the normal restore path can verify it. */
export async function downloadBackup(target: ReadTarget, name: string, destDir: string): Promise<BackupManifest> {
  const manifestOut = await withRetry(() => target.client.send(new GetObjectCommand({ Bucket: target.bucket, Key: keyFor(target.prefix, name, 'manifest.json') })));
  const manifestBytes = await readBody(manifestOut.Body, MANIFEST_MAX_BYTES);
  const manifest = parseManifest(manifestBytes.toString('utf8')); // validates the file name before it is used as a path
  const manifestFile = await open(`${destDir}/manifest.json`, 'wx', 0o600);
  try {
    await manifestFile.writeFile(manifestBytes);
  } finally {
    await manifestFile.close();
  }

  const dumpOut = await withRetry(() => target.client.send(new GetObjectCommand({ Bucket: target.bucket, Key: keyFor(target.prefix, name, manifest.dump.file) })));
  const file = await open(`${destDir}/${manifest.dump.file}`, 'wx', 0o600); // already open, so no cleanup can race a pending open
  try {
    await pipeline(dumpOut.Body as Readable, new CapBytes(manifest.dump.bytes), file.createWriteStream());
  } finally {
    await file.close().catch(() => undefined); // intentional: pipeline already closed it on the normal path
  }
  return manifest;
}

export type { BackupManifestV2 };
