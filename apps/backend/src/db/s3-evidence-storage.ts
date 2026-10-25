import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { S3Client, GetObjectCommand, ListObjectsV2Command, ListObjectVersionsCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { EvidenceError, EvidenceObjectTooLargeError, IncompleteEvidenceListingError, type EvidencePolicy } from './evidence-catalogue';
import type { EvidenceBudget, EvidenceObject, EvidenceStorage, KeyPage, VersionPage } from './evidence-storage';

export interface EvidenceS3Settings {
  bucket: string;
  prefix: string;
  region: string;
  endpoint?: string;
  /** Explicit ops credentials only; never the application's ambient default chain. */
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
}
const missing = (e: unknown) =>
  ['NoSuchKey', 'NoSuchVersion', 'NotFound'].includes((e as { name?: string }).name ?? '') || (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404;
const transient = (e: unknown) => {
  const error = e as { name?: string; code?: string; $metadata?: { httpStatusCode?: number } };
  return (
    ['SlowDown', 'ServiceUnavailable', 'InternalError', 'TimeoutError'].includes(error.name ?? '') ||
    ['ECONNRESET', 'ETIMEDOUT'].includes(error.code ?? '') ||
    (error.$metadata?.httpStatusCode ?? 0) >= 500
  );
};
export class S3EvidenceStorage implements EvidenceStorage {
  readonly bucket: string;
  readonly prefix: string;
  private readonly client: S3Client;
  constructor(settings: EvidenceS3Settings) {
    if (
      !settings.credentials.accessKeyId ||
      !settings.credentials.secretAccessKey ||
      !settings.bucket ||
      !settings.prefix ||
      !settings.prefix.endsWith('/') ||
      settings.prefix.includes('..')
    )
      throw new EvidenceError('storage');
    this.bucket = settings.bucket;
    this.prefix = settings.prefix;
    this.client = new S3Client({
      region: settings.region,
      endpoint: settings.endpoint,
      forcePathStyle: Boolean(settings.endpoint),
      credentials: settings.credentials,
      maxAttempts: 1,
    });
  }
  destroy(): void {
    this.client.destroy();
  }
  private allowed(key: string): void {
    if (!key.startsWith(this.prefix) || key.length > 1024 || key.includes('..')) throw new EvidenceError('storage');
  }
  /** Timer spans response body consumption; write replies are never blindly retried. */
  private async request<T>(budget: EvidenceBudget, retry: boolean, listing: boolean, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      let duration: number;
      try {
        duration = budget.remainingMs();
      } catch {
        throw listing ? new IncompleteEvidenceListingError('timeout') : new EvidenceError('limit');
      }
      const timer = setTimeout(() => controller.abort(), duration);
      try {
        return await operation(controller.signal);
      } catch (e) {
        if (e instanceof EvidenceError) throw e;
        if (controller.signal.aborted) throw listing ? new IncompleteEvidenceListingError('timeout') : new EvidenceError('limit');
        if (retry && attempt < 2 && transient(e)) continue;
        // Strip provider messages/URLs before crossing the operational boundary.
        throw new EvidenceError('storage');
      } finally {
        clearTimeout(timer);
      }
    }
  }
  async get(key: string, version: string | undefined, limit: number, budget: EvidenceBudget): Promise<EvidenceObject | undefined> {
    this.allowed(key);
    return this.request(budget, true, false, async (signal) => {
      let out;
      try {
        out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, ...(version === undefined ? {} : { VersionId: version }) }), { abortSignal: signal });
      } catch (e) {
        if (missing(e)) return undefined;
        throw e;
      }
      const body = out.Body as Readable;
      const chunks: Buffer[] = [];
      let size = 0;
      const hash = createHash('sha256');
      const abort = () => body.destroy(new EvidenceError('limit'));
      signal.addEventListener('abort', abort, { once: true });
      try {
        if (signal.aborted) throw new EvidenceError('limit');
        for await (const piece of body) {
          const bytes = piece as Buffer;
          size += bytes.length;
          budget.read(bytes.length);
          if (size > limit) throw new EvidenceObjectTooLargeError();
          hash.update(bytes);
          chunks.push(bytes);
        }
        budget.check();
        if (!out.VersionId && version !== undefined && version !== 'null') throw new EvidenceError('integrity');
        // A missing header on an unversioned read is explicit null-state, never a made-up PDF pin.
        return {
          bytes: Buffer.concat(chunks),
          version: out.VersionId ?? 'null',
          sha256: hash.digest('hex'),
          contentType: out.ContentType ?? '',
          token: out.Metadata?.['evidence-token'],
          encryption: out.ServerSideEncryption,
          keyId: out.SSEKMSKeyId,
          retentionMode: out.ObjectLockMode,
          retainUntil: out.ObjectLockRetainUntilDate?.toISOString(),
        };
      } finally {
        signal.removeEventListener('abort', abort);
        body.destroy();
      }
    });
  }
  async versions(key: string, cursor: { keyMarker?: string; versionMarker?: string }, budget: EvidenceBudget): Promise<VersionPage> {
    this.allowed(key);
    return this.request(budget, true, true, async (signal) => {
      const out = await this.client.send(new ListObjectVersionsCommand({ Bucket: this.bucket, Prefix: key, KeyMarker: cursor.keyMarker, VersionIdMarker: cursor.versionMarker }), {
        abortSignal: signal,
      });
      if (typeof out.IsTruncated !== 'boolean') throw new IncompleteEvidenceListingError('cursor');
      const versions = [
        ...(out.Versions ?? []).map((v) => ({ key: v.Key, version: v.VersionId, deleted: false })),
        ...(out.DeleteMarkers ?? []).map((v) => ({ key: v.Key, version: v.VersionId, deleted: true })),
      ];
      if (versions.some((v) => !v.key || !v.version)) throw new EvidenceError('integrity');
      return { versions: versions as VersionPage['versions'], truncated: out.IsTruncated, keyMarker: out.NextKeyMarker, versionMarker: out.NextVersionIdMarker };
    });
  }
  async keys(token: string | undefined, budget: EvidenceBudget): Promise<KeyPage> {
    return this.request(budget, true, true, async (signal) => {
      const out = await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: this.prefix, ContinuationToken: token }), { abortSignal: signal });
      if (typeof out.IsTruncated !== 'boolean' || (out.Contents ?? []).some((o) => !o.Key)) throw new IncompleteEvidenceListingError('cursor');
      return { keys: (out.Contents ?? []).map((o) => o.Key!), truncated: out.IsTruncated, token: out.NextContinuationToken };
    });
  }
  async put(key: string, bytes: Buffer, contentType: string, token: string, policy: EvidencePolicy, budget: EvidenceBudget): Promise<void> {
    this.allowed(key);
    budget.written(bytes.length);
    await this.request(budget, false, false, async (signal) => {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: bytes,
          ContentLength: bytes.length,
          ContentType: contentType,
          Metadata: { 'evidence-token': token },
          ObjectLockMode: policy.mode,
          ObjectLockRetainUntilDate: new Date(policy.retainUntil),
          ServerSideEncryption: policy.encryption,
          SSEKMSKeyId: policy.keyId ?? undefined,
          // Immutable generation objects; race/retry cannot overwrite a current object.
          IfNoneMatch: '*',
        }),
        { abortSignal: signal },
      );
    });
  }
}
