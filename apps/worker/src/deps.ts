import type { Logger } from './log';

/**
 * What a handler is given. A handler reaches data through these and nothing else: it receives no database connection, no repository and no credentials of its own.
 * Every database call names the job the worker holds, and the database refuses it unless that job is running, held by this worker, and of the type allowed
 * (migration 0024), and then acts for that job's organization only.
 */
export interface VerifyTarget {
  reportId: string;
  storageKey: string;
  objectVersion: string;
  sha256: string;
  sizeBytes: number;
  contentType: string;
}

export type VerifyOutcome = 'ok' | 'missing' | 'changed' | 'unreadable';

export interface JobData {
  /** The pinned facts of the report a `files.verify-stored` job is about; undefined when there is nothing to check (the report is gone or has no uploaded file). */
  verifyTarget(jobId: string, workerId: string): Promise<VerifyTarget | undefined>;
  /** Up to `limit` of the organization's uploaded reports not checked for `maxAgeSeconds` (a `files.verify-stale` job). */
  verifyStale(jobId: string, workerId: string, limit: number, maxAgeSeconds: number): Promise<VerifyTarget[]>;
  recordVerification(jobId: string, workerId: string, reportId: string, outcome: VerifyOutcome, reason: string | undefined, objectVersion: string): Promise<void>;
  /** Sweeps the organization of an `uploads.sweep` job. Deletes nothing from the bucket. */
  sweepUploads(jobId: string, workerId: string): Promise<{ released: number; releasedBytes: number; objectsKept: number }>;
}

export interface InspectedFile {
  sizeBytes: number;
  sha256: string;
  contentType: string | undefined;
}

/** Reads one stored object VERSION. Resolves `'missing'` when that version does not exist; never falls back to the latest object. Throws when the store cannot be read. */
export interface ObjectInspector {
  inspect(key: string, version: string, options: { maxBytes: number; signal?: AbortSignal }): Promise<InspectedFile | 'missing' | 'too-large'>;
}

export interface HandlerDeps {
  data: JobData;
  inspector: ObjectInspector;
  log: Logger;
}
