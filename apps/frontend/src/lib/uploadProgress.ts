import { z } from 'zod';

/** What the server tells the browser about an upload attempt. */
export const attemptSchema = z.strictObject({
  attemptId: z.uuid(), revision: z.uuid(), expiresAt: z.iso.datetime(),
  state: z.enum(['declared', 'intaking', 'stored', 'unresolved', 'cancelling', 'cancelled', 'committed', 'cleanup', 'cleaned']),
});
export type Attempt = z.infer<typeof attemptSchema>;

/** The original declaration of an attempt; replaying it (same request id) returns the attempt's durable state. */
export const declarationSchema = z.strictObject({
  requestId: z.uuid(), revision: z.uuid(), contentType: z.string().min(1).max(100), sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type Declaration = z.infer<typeof declarationSchema>;

/** What identifies the file of an upload without being the file: enough to recognize the same file again, nothing about the patient. */
export const fileFactsSchema = z.strictObject({
  reportType: z.enum(['vcf', 'structured', 'lab-pdf']),
  name: z.string().min(1).max(100),
  sizeBytes: z.number().int().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type FileFacts = z.infer<typeof fileFactsSchema>;

export interface OwnedProgress {
  declaration?: Declaration;
  attempt?: Attempt;
  cancelRequested?: boolean;
  /** The file this progress is about (set once the file has been read). */
  facts?: FileFacts;
  /** True when this progress was restored after a reload; the server confirms or refuses it on the first request. */
  restored?: boolean;
}
