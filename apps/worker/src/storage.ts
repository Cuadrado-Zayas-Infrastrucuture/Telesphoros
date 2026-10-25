import { createHash } from 'node:crypto';
import type { S3Client } from '@aws-sdk/client-s3';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import type { InspectedFile, ObjectInspector } from './deps';

/**
 * Reads a stored report file for the integrity re-check. It is given a bucket and reads with GET on a named VERSION only; it can write nothing (the worker's IAM role
 * is read-only on the reports prefix, M2.3c). The read is bounded: a stored object larger than the report says is reported as such after `maxBytes + 1` bytes,
 * not read to the end.
 */
export class S3ObjectInspector implements ObjectInspector {
  constructor(private readonly client: S3Client, private readonly bucket: string) {}

  async inspect(key: string, version: string, options: { maxBytes: number; signal?: AbortSignal }): Promise<InspectedFile | 'missing' | 'too-large'> {
    let response;
    try {
      response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, VersionId: version }), { abortSignal: options.signal });
    } catch (error) {
      // Only these two say something about THIS object. A bare 404 is not enough: NoSuchBucket is also a 404, and a wrong or deleted bucket would
      // otherwise be recorded as a missing file for every report checked. Anything else is a failure to read (the job retries, then ends dead and alarms).
      const e = error as { name?: string };
      if (e.name === 'NoSuchKey' || e.name === 'NoSuchVersion') return 'missing';
      throw error;
    }
    const body = response.Body as AsyncIterable<Uint8Array> | undefined;
    if (!body) throw new Error('empty-body');
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of body) {
      size += chunk.length;
      if (size > options.maxBytes) {
        (response.Body as { destroy?: () => void }).destroy?.();
        return 'too-large';
      }
      hash.update(chunk);
    }
    return { sizeBytes: size, sha256: hash.digest('hex'), contentType: response.ContentType };
  }
}

/**
 * The start-up check that REPORTS_BUCKET names a bucket that exists. The worker's role may not list or head a bucket (no s3:ListBucket, by design), so it asks the one
 * question it is allowed to ask, for a key under reports/. S3 answers a bucket that is not there with NoSuchBucket, and that is the only answer that counts: a key that
 * is not there (NoSuchKey, or AccessDenied where the role cannot list), an outage, or no answer within `timeoutMs` say nothing about the bucket and must not stop a
 * worker from starting. Reads nothing back and writes nothing.
 */
export async function bucketIsMissing(client: S3Client, bucket: string, timeoutMs = 5000): Promise<boolean> {
  try {
    const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: 'reports/.worker-startup-check' }), { abortSignal: AbortSignal.timeout(timeoutMs) });
    (response.Body as { destroy?: () => void } | undefined)?.destroy?.();
    return false;
  } catch (error) {
    return (error as { name?: string }).name === 'NoSuchBucket';
  }
}
