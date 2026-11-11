import { z } from 'zod';

/**
 * What the API tells the browser about one upload attempt (`POST /reports/:id/upload-attempts`, `.../resume`, `.../cancel`, `.../bytes`).
 * The stored attempt also holds its storage key, tenant, principal and digests; none of those leaves the server, and this strict schema refuses a
 * response that carries any of them.
 */
export const uploadAttemptDtoSchema = z.strictObject({
  attemptId: z.uuid(),
  revision: z.uuid(),
  expiresAt: z.iso.datetime(),
  state: z.enum(['declared', 'intaking', 'stored', 'unresolved', 'cancelling', 'cancelled', 'committed', 'cleanup', 'cleaned']),
});
export type UploadAttemptDto = z.infer<typeof uploadAttemptDtoSchema>;

/** `GET /reports/:id/upload-state`: the revision a new attempt must name, whether a file is stored, and counts for the intake run. */
export const uploadStateDtoSchema = z.strictObject({
  revision: z.uuid(),
  fileUploaded: z.boolean(),
  run: z.strictObject({
    pendingBytes: z.number().int().min(0),
    pendingCount: z.number().int().min(0),
    lastReconciledAt: z.iso.datetime().nullable(),
    cleanupStalled: z.boolean(),
  }),
});
export type UploadStateDto = z.infer<typeof uploadStateDtoSchema>;
