import { createHash } from 'node:crypto';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
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
      const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (e.name === 'NoSuchKey' || e.name === 'NoSuchVersion' || e.$metadata?.httpStatusCode === 404) return 'missing';
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
