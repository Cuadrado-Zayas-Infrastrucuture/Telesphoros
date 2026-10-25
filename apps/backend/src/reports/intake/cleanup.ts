import { AbortMultipartUploadCommand, DeleteObjectCommand, GetBucketVersioningCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { ReportsRepository } from '../../storage/reports.repository';
import { IncompleteUploadInventoryError, uploadVersions, uploadMultipart } from '../../object-storage/upload-inventory';
import { loopback } from './local-policy';
export interface CleanupReceipt {
  runId: string;
  tenantId: string;
  bucket: string;
  endpoint: string;
  databaseUrl: string;
  databaseName: string;
  /** Trusted durable setup receipt. No receipt -> no cleanup, even when a row seems absent. */
  owned: true;
  clinicalProcessing: 'disabled';
  graceSeconds: number;
  /** Local catalogue/evidence inventory must finish affirmatively before deletion. Never infer absence from a failed read. */
  evidenceInventory(): Promise<{
    complete: true;
    protectedKeys: string[];
  }>;
  /** Durable owned multipart receipts; unknown IDs are retained. The L3 writer will supply these. */
  multipartReceipts: {
    key: string;
    uploadId: string;
  }[];
}
/** Separate operations identity/entry point. Not injected into the application and cannot touch cloud or recovery storage. */
export class LocalUploadCleanup {
  private readonly client: S3Client;
  constructor(
    private readonly reports: ReportsRepository,
    private readonly receipt: CleanupReceipt,
  ) {
    if (
      !receipt.owned ||
      receipt.clinicalProcessing !== 'disabled' ||
      !loopback(receipt.endpoint) ||
      !loopback(receipt.databaseUrl) ||
      receipt.bucket !== `synthetic-storage-${receipt.runId}` ||
      !/^[-0-9a-f]{36}$/.test(receipt.runId) ||
      !Number.isSafeInteger(receipt.graceSeconds) ||
      receipt.graceSeconds < 0 ||
      receipt.graceSeconds > 604800 ||
      !/^(test_|synthetic_storage_)[a-z0-9_]+$/.test(receipt.databaseName) ||
      decodeURIComponent(new URL(receipt.databaseUrl).pathname.slice(1)) !== receipt.databaseName
    )
      throw new Error('Unowned or non-local cleanup refused.');
    this.client = new S3Client({
      region: 'us-east-2',
      endpoint: receipt.endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: 'local-cleanup', secretAccessKey: 'local-cleanup' },
      maxAttempts: 1,
    });
  }
  close() {
    this.client.destroy();
  }
  async run() {
    try {
      const result = await this.reconcile();
      await this.reports.recordReconciliation(this.receipt.tenantId, this.receipt.runId, result.unknownVersions === 0);
      return result;
    } catch (error) {
      try {
        await this.reports.recordReconciliation(this.receipt.tenantId, this.receipt.runId, false);
      } catch {
        /* Unknown DB outcome stays unconfirmed. */
      }
      throw error;
    }
  }
  private async reconcile() {
    const r = this.receipt;
    const signal = AbortSignal.timeout(30000);
    const prefix = `local-storage/${r.runId}/`;
    const policy = await this.client.send(new GetBucketVersioningCommand({ Bucket: r.bucket }), { abortSignal: signal });
    if (policy.Status !== 'Enabled') throw new IncompleteUploadInventoryError();
    const evidence = await this.bounded(r.evidenceInventory(), signal);
    if (evidence.complete !== true) throw new IncompleteUploadInventoryError();
    const versions = await uploadVersions(this.client, r.bucket, prefix, signal);
    const multipart = await this.multipart(prefix, signal);
    const known = await this.bounded(this.reports.runAttempts(r.tenantId, r.runId), signal);
    const attempts = await this.bounded(this.reports.sweepCandidates(r.tenantId, r.runId), signal);
    if (attempts.length > 100) throw new IncompleteUploadInventoryError();
    // Finish reference and retention inspection before the first deletion. Any unavailable read aborts all destructive work.
    const plans = [];
    for (const a of attempts) {
      if (!a.key.startsWith(prefix) || a.runId !== r.runId) throw new IncompleteUploadInventoryError();
      const exact = versions.filter((v) => v.key === a.key);
      let protectedObject = evidence.protectedKeys.includes(a.key);
      for (const v of exact) {
        if (await this.bounded(this.reports.referenced(r.tenantId, v.key, v.version), signal)) protectedObject = true;
        if (!v.deleted) {
          const h = await this.client.send(new HeadObjectCommand({ Bucket: r.bucket, Key: v.key, VersionId: v.version }), { abortSignal: signal });
          if (
            h.ObjectLockLegalHoldStatus === 'ON' ||
            h.ObjectLockMode ||
            h.ObjectLockRetainUntilDate ||
            h.Metadata?.['upload-run'] !== r.runId ||
            h.Metadata?.['upload-attempt'] !== a.id
          )
            protectedObject = true;
        }
      }
      const parts = multipart.filter((u) => u.key === a.key);
      const ownedParts = parts.filter((u) => r.multipartReceipts.some((p) => p.key === u.key && p.uploadId === u.uploadId));
      if (parts.length !== ownedParts.length) protectedObject = true;
      plans.push({ a, exact, parts: ownedParts, protectedObject });
    }
    if (signal.aborted) throw new IncompleteUploadInventoryError();
    let actions = 0,
      cleaned = 0,
      preserved = 0;
    let pendingBytes = 0;
    for (const p of plans) {
      pendingBytes += p.a.sizeBytes;
      if (
        p.protectedObject ||
        actions + p.exact.length + p.parts.length > 100 ||
        signal.aborted ||
        !(await this.bounded(this.reports.claimCleanup(r.tenantId, p.a.id, r.graceSeconds), signal))
      ) {
        preserved++;
        continue;
      }
      for (const v of p.exact) {
        if (await this.bounded(this.reports.referenced(r.tenantId, v.key, v.version), signal)) throw new IncompleteUploadInventoryError();
        await this.client.send(new DeleteObjectCommand({ Bucket: r.bucket, Key: v.key, VersionId: v.version }), { abortSignal: signal });
        actions++;
      }
      for (const u of p.parts) {
        await this.client.send(new AbortMultipartUploadCommand({ Bucket: r.bucket, Key: u.key, UploadId: u.uploadId }), { abortSignal: signal });
        actions++;
      }
      const remaining = await uploadVersions(this.client, r.bucket, p.a.key, signal);
      if (remaining.some((v) => v.key === p.a.key)) throw new IncompleteUploadInventoryError();
      if ((await this.multipart(p.a.key, signal)).some((u) => u.key === p.a.key)) throw new IncompleteUploadInventoryError();
      await this.bounded(this.reports.finishCleanup(r.tenantId, p.a.id), signal);
      cleaned++;
      pendingBytes -= p.a.sizeBytes;
    }
    if (signal.aborted) throw new IncompleteUploadInventoryError();
    return {
      cleaned,
      preserved,
      actions,
      pendingBytes,
      candidates: attempts.length,
      reconciledAt: new Date().toISOString(),
      unknownVersions: versions.filter((v) => !known.some((a) => a.key === v.key)).length,
    };
  }
  private async bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw new IncompleteUploadInventoryError();
    let abort: (() => void) | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          abort = () => reject(new IncompleteUploadInventoryError());
          signal.addEventListener('abort', abort, { once: true });
        }),
      ]);
    } finally {
      if (abort) signal.removeEventListener('abort', abort);
    }
  }
  private async multipart(prefix: string, signal: AbortSignal) {
    return uploadMultipart(this.client, this.receipt.bucket, prefix, signal);
  }
}
