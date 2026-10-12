import type { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { type FetchedObject, type InspectedObject, ObjectStorage, ObjectTooLargeError, type UploadTarget } from './object-storage';

interface StoredVersion {
  version: string;
  bytes: Buffer;
  contentType: string;
}

/**
 * Development/test store. `put` stands in for the browser's direct upload. It keeps every version, like a versioned bucket,
 * so the version rules (pinning, no fallback to the latest) are testable without a server.
 */
@Injectable()
export class InMemoryObjectStorage extends ObjectStorage {
  private readonly objects = new Map<string, StoredVersion[]>();
  private counter = 0;
  /** Set false to behave like an unversioned bucket: writes get no version id. */
  versioned = true;

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

  /** Test helper: the browser's PUT. Returns the version id the store assigned (a second call overwrites with a NEW version). */
  put(key: string, bytes: Buffer, contentType: string): string | undefined {
    const version = this.versioned ? `mem-v${++this.counter}` : undefined;
    const kept = this.versioned ? (this.objects.get(key) ?? []) : [];
    kept.push({ version: version ?? 'null', bytes, contentType });
    this.objects.set(key, kept);
    return version;
  }

  /** Test helper: the break-glass act of deleting one version. */
  deleteVersion(key: string, version: string): void {
    this.objects.set(key, (this.objects.get(key) ?? []).filter((v) => v.version !== version));
  }

  private find(key: string, version?: string): StoredVersion | undefined {
    const versions = this.objects.get(key) ?? [];
    return version === undefined ? versions[versions.length - 1] : versions.find((v) => v.version === version);
  }

  private describe(found: StoredVersion): InspectedObject {
    return {
      sizeBytes: found.bytes.length,
      contentType: found.contentType,
      sha256: createHash('sha256').update(found.bytes).digest('hex'),
      version: found.version === 'null' ? undefined : found.version,
    };
  }

  async inspect(key: string, options: { version?: string } = {}): Promise<InspectedObject | undefined> {
    const found = this.find(key, options.version);
    return found ? this.describe(found) : undefined;
  }

  async getObject(key: string, options: { version?: string; maxBytes: number }): Promise<FetchedObject | undefined> {
    const found = this.find(key, options.version);
    if (!found) return undefined;
    if (found.bytes.length > options.maxBytes) throw new ObjectTooLargeError(options.maxBytes);
    return { ...this.describe(found), bytes: Buffer.from(found.bytes) };
  }

  async putObject(key: string, bytes: Buffer, contentType: string): Promise<{ version: string | undefined }> {
    return { version: this.put(key, bytes, contentType) };
  }

  async createDownloadUrl(key: string, version: string, ttlSeconds: number): Promise<string> {
    return `memory://download/${key}?versionId=${encodeURIComponent(version)}&expires=${ttlSeconds}`;
  }

  async uploadVersions(key: string, signal: AbortSignal) { if(signal.aborted)throw new Error('Incomplete inventory');return [...this.objects.entries()].filter(([k])=>k.startsWith(key)).flatMap(([k,values])=>values.map(v=>({key:k,version:v.version,deleted:false}))); }

  async uploadMultipart(_key:string,signal:AbortSignal) {void _key;if(signal.aborted)throw new Error('Incomplete inventory');return [];}

  async putStream(key: string, stream: Readable, contentType: string, size: number, signal: AbortSignal) {
    // Test-only store necessarily retains bytes. Production S3 streaming never takes this path.
    if (this.objects.has(key) || signal.aborted) throw new Error('Write refused');
    const chunks: Buffer[] = []; let count = 0;
    for await (const chunk of stream) { if (signal.aborted) throw new Error('Write cancelled'); count += chunk.length; if (count > size) throw new ObjectTooLargeError(size); chunks.push(chunk); }
    if (count !== size) throw new Error('Incomplete write');
    return this.putObject(key, Buffer.concat(chunks), contentType);
  }

  async versioningEnabled(): Promise<boolean> {
    return this.versioned;
  }
}
