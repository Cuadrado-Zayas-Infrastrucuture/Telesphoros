import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { GetBucketVersioningCommand, GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable } from '@nestjs/common';
import { MAX_REPORT_BYTES } from '@telesphoros/shared-types';
import { type FetchedObject, type InspectedObject, ObjectStorage, ObjectTooLargeError, type UploadTarget } from './object-storage';

const isMissing = (error: unknown): boolean => {
  const { name, $metadata } = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return name === 'NoSuchKey' || name === 'NoSuchVersion' || $metadata?.httpStatusCode === 404;
};

/** S3 reports the literal "null" for an object written before versioning was on. That is not a version we can pin. */
const realVersion = (id: string | undefined): string | undefined => (id && id !== 'null' ? id : undefined);

@Injectable()
export class S3ObjectStorage extends ObjectStorage {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
    private readonly ttlSeconds: number,
  ) {
    super();
  }

  async createUploadTarget({ key, contentType, sizeBytes }: { key: string; contentType: string; sizeBytes: number }): Promise<UploadTarget> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
      ContentLength: sizeBytes,
    });
    const url = await getSignedUrl(this.client, command, {
      expiresIn: this.ttlSeconds,
      // Sign the content type and length, so the URL only works for the file that was announced.
      signableHeaders: new Set(['content-type', 'content-length']),
    });
    return {
      url,
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      expiresAt: new Date(Date.now() + this.ttlSeconds * 1000).toISOString(),
    };
  }

  /**
   * ONE GetObject: the version id and the bytes come from the same response. Streams, never buffers beyond `keep`:
   * hashes as the bytes flow by, and stops reading once past the limit.
   */
  private async read(key: string, version: string | undefined, limit: number, keep: boolean): Promise<(InspectedObject & { bytes?: Buffer; tooLarge: boolean }) | undefined> {
    let response;
    try {
      response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, ...(version === undefined ? {} : { VersionId: version }) }));
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
    const hash = createHash('sha256');
    const chunks: Buffer[] = [];
    let sizeBytes = 0;
    let tooLarge = false;
    const body = response.Body as Readable;
    for await (const chunk of body) {
      sizeBytes += (chunk as Buffer).length;
      hash.update(chunk as Buffer);
      if (keep) chunks.push(chunk as Buffer);
      if (sizeBytes > limit) {
        tooLarge = true;
        body.destroy();
        break; // the caller refuses it; the partial hash is irrelevant
      }
    }
    return {
      sizeBytes,
      contentType: response.ContentType,
      sha256: hash.digest('hex'),
      version: realVersion(response.VersionId),
      tooLarge,
      ...(keep && !tooLarge ? { bytes: Buffer.concat(chunks) } : {}),
    };
  }

  async inspect(key: string, options: { version?: string } = {}): Promise<InspectedObject | undefined> {
    const read = await this.read(key, options.version, MAX_REPORT_BYTES, false);
    if (!read) return undefined;
    const { sizeBytes, contentType, sha256, version } = read;
    return { sizeBytes, contentType, sha256, version };
  }

  async getObject(key: string, options: { version?: string; maxBytes: number }): Promise<FetchedObject | undefined> {
    const read = await this.read(key, options.version, options.maxBytes, true);
    if (!read) return undefined;
    if (read.tooLarge) throw new ObjectTooLargeError(options.maxBytes);
    const { sizeBytes, contentType, sha256, version, bytes } = read;
    return { sizeBytes, contentType, sha256, version, bytes: bytes! };
  }

  async putObject(key: string, bytes: Buffer, contentType: string): Promise<{ version: string | undefined }> {
    const response = await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: bytes, ContentType: contentType, ContentLength: bytes.length }));
    return { version: realVersion(response.VersionId) };
  }

  createDownloadUrl(key: string, version: string, ttlSeconds: number): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key, VersionId: version }), { expiresIn: ttlSeconds });
  }

  async versioningEnabled(): Promise<boolean> {
    const { Status } = await this.client.send(new GetBucketVersioningCommand({ Bucket: this.bucket }));
    return Status === 'Enabled';
  }
}
