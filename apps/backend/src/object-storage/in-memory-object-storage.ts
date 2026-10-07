import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { type InspectedObject, ObjectStorage, type UploadTarget } from './object-storage';

/** Development/test store. `put` stands in for the browser's direct upload. */
@Injectable()
export class InMemoryObjectStorage extends ObjectStorage {
  private readonly objects = new Map<string, { bytes: Buffer; contentType: string }>();

  constructor(private readonly ttlSeconds = 300) {
    super();
  }

  async createUploadTarget({ key, contentType }: { key: string; contentType: string; sizeBytes: number }): Promise<UploadTarget> {
    return {
      url: `memory://reports/${key}`,
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      expiresAt: new Date(Date.now() + this.ttlSeconds * 1000).toISOString(),
    };
  }

  put(key: string, bytes: Buffer, contentType: string) {
    this.objects.set(key, { bytes, contentType });
  }

  async inspect(key: string): Promise<InspectedObject | undefined> {
    const object = this.objects.get(key);
    if (!object) return undefined;
    return {
      sizeBytes: object.bytes.length,
      contentType: object.contentType,
      sha256: createHash('sha256').update(object.bytes).digest('hex'),
    };
  }
}
