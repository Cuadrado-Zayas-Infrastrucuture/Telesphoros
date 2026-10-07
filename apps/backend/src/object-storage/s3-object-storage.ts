import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable } from '@nestjs/common';
import { MAX_REPORT_BYTES } from '@telesphoros/shared-types';
import { type InspectedObject, ObjectStorage, type UploadTarget } from './object-storage';

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

  async inspect(key: string): Promise<InspectedObject | undefined> {
    let response;
    try {
      response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      const { name, $metadata } = error as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (name === 'NoSuchKey' || $metadata?.httpStatusCode === 404) return undefined;
      throw error;
    }

    // Stream, never buffer: hash as the bytes flow by, and stop reading once past the size limit.
    const hash = createHash('sha256');
    let sizeBytes = 0;
    const body = response.Body as Readable;
    for await (const chunk of body) {
      sizeBytes += (chunk as Buffer).length;
      hash.update(chunk as Buffer);
      if (sizeBytes > MAX_REPORT_BYTES) {
        body.destroy();
        break; // the size check in the caller will fail it; the partial hash is irrelevant
      }
    }
    return { sizeBytes, contentType: response.ContentType, sha256: hash.digest('hex') };
  }
}
