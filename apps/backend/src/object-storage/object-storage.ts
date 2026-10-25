import type { UploadVersion, UploadMultipart } from './upload-inventory';
import type { Readable } from 'node:stream';
export interface InspectedObject {
  sizeBytes: number;
  contentType: string | undefined;
  /** Lowercase hex SHA-256 computed by streaming the stored bytes. */
  sha256: string;
  /**
   * The storage version the bytes above came from, read from the SAME response as the bytes (never asked for separately, which
   * could name a different object after an overwrite). Undefined when the store reports none: an object written without versioning
   * (S3's literal "null" is normalised to undefined). Such an object cannot be pinned.
   */
  version: string | undefined;
}

export interface FetchedObject extends InspectedObject {
  bytes: Buffer;
}

/** The object is larger than the caller allowed. Nothing was kept. */
export class ObjectTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super('The stored object is larger than the limit.');
    this.name = 'ObjectTooLargeError';
  }
}

/**
 * Where report files live. The database stores only metadata and a key, never the bytes.
 * The S3 implementation covers AWS S3 and S3-compatible servers (MinIO) alike.
 *
 * Reads of evidence name a VERSION. A missing version is "not found" (undefined); it never falls back to the latest object.
 */
export abstract class ObjectStorage {
  /**
   * Streams the stored object to measure it, in ONE request: hash, size and version all describe the same bytes. Without `version`
   * it reads the current object (the upload check); with it, exactly that version (the capture check). Returns undefined if no such
   * object (or version) exists. This is what makes the upload trustworthy: we verify the bytes ourselves instead of taking the
   * client's word for their size or checksum.
   */
  abstract inspect(key: string, options?: { version?: string; signal?: AbortSignal }): Promise<InspectedObject | undefined>;

  /** Like `inspect` (same single request) but also keeps the bytes. Throws ObjectTooLargeError beyond `maxBytes`. Undefined if missing. */
  abstract getObject(key: string, options: { version?: string; maxBytes: number }): Promise<FetchedObject | undefined>;

  /** Writes an object server-side (e.g. extracted text). Returns the version the store assigned, if it versions. */
  abstract putObject(key: string, bytes: Buffer, contentType: string): Promise<{ version: string | undefined }>;

  /** A short-lived link that downloads exactly this VERSION. A bearer credential: never log it. */
  abstract createDownloadUrl(key: string, version: string, ttlSeconds: number, options?: { filename: string }): Promise<string>;

  /** Validated owned file stream; unsupported/read-only adapters refuse rather than buffer or grant a write. */
  async uploadVersions(_key: string, _signal: AbortSignal): Promise<UploadVersion[]> {
    void _key;
    void _signal;
    throw new Error('Upload inventory unavailable.');
  }

  async uploadMultipart(_key: string, _signal: AbortSignal): Promise<UploadMultipart[]> {
    void _key;
    void _signal;
    throw new Error('Multipart inventory unavailable.');
  }

  async putStream(
    _key: string,
    _bytes: Readable,
    _contentType: string,
    _size: number,
    _signal: AbortSignal,
    _metadata?: Record<string, string>,
  ): Promise<{ version: string | undefined }> {
    void _key;
    void _bytes;
    void _contentType;
    void _size;
    void _signal;
    void _metadata;
    throw new Error('Streaming writes unavailable.');
  }

  /** True when the store keeps object versions (the bucket's versioning is enabled). Startup refuses the pipeline otherwise. */
  abstract versioningEnabled(): Promise<boolean>;
}
