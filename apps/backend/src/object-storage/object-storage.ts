export interface UploadTarget {
  url: string;
  method: 'PUT';
  /** Headers the uploader MUST send; they are part of what the URL was signed for. */
  headers: Record<string, string>;
  expiresAt: string;
}

export interface InspectedObject {
  sizeBytes: number;
  contentType: string | undefined;
  /** Lowercase hex SHA-256 computed by streaming the stored bytes. */
  sha256: string;
}

/**
 * Where report files live. The database stores only metadata and a key, never the bytes.
 * The S3 implementation covers AWS S3 and S3-compatible servers (MinIO) alike.
 */
export abstract class ObjectStorage {
  abstract createUploadTarget(input: { key: string; contentType: string; sizeBytes: number }): Promise<UploadTarget>;

  /**
   * Streams the stored object to measure it. Returns undefined if no such object exists.
   * This is what makes the upload trustworthy: we verify the bytes ourselves instead of taking
   * the client's word for their size or checksum.
   */
  abstract inspect(key: string): Promise<InspectedObject | undefined>;
}
