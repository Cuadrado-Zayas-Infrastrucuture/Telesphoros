import { z } from 'zod';
import { defineJob, ID_STRING } from './registry';

/**
 * The production job types. The API never enqueues these directly: the first is scheduled by the database (`job_schedules`), the second is the outbox route of
 * `report.file-committed`, and the third is scheduled. A new type is a new line here, a route or schedule row in a migration, and a handler in the worker.
 */

/** Closes abandoned upload attempts of one organization and returns their quota (hourly per organization). Deletes nothing from the bucket. */
export const uploadsSweep = defineJob({ type: 'uploads.sweep', payload: z.strictObject({}), maxAttempts: 5, leaseSeconds: 60, timeoutSeconds: 120 });

/** Re-reads the stored object VERSION a report is pinned to and compares size, content type and SHA-256 with the report (after every committed upload). */
export const filesVerifyStored = defineJob({ type: 'files.verify-stored', payload: z.strictObject({ reportId: z.string().uuid(), requestId: z.string().regex(ID_STRING).optional() }), maxAttempts: 5, leaseSeconds: 60, timeoutSeconds: 300 });

/** The integrity re-check: up to a bounded number of an organization's reports not checked for a long time (daily per organization). */
export const filesVerifyStale = defineJob({ type: 'files.verify-stale', payload: z.strictObject({}), maxAttempts: 3, leaseSeconds: 60, timeoutSeconds: 1800 });

export const PRODUCTION_JOBS = [uploadsSweep, filesVerifyStored, filesVerifyStale] as const;
