import { z } from 'zod';

/**
 * Stable machine-readable error codes. The frontend switches on `code`, never on `message`
 * (messages are for humans and may change). Add codes; never rename or remove one.
 */
export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  /** Reserved for Phase 9 (rate limiting). */
  RATE_LIMITED: 'RATE_LIMITED',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  /** The lab-report pipeline is switched off (503, no Retry-After: only an operator can change that). */
  PIPELINE_DISABLED: 'PIPELINE_DISABLED',
  /** The reader's capacity is full (503 + Retry-After). Nothing was queued. */
  PIPELINE_BUSY: 'PIPELINE_BUSY',
  /** The reader failed to run or ran out of time (503 + Retry-After). Nothing was stored. */
  READER_UNAVAILABLE: 'READER_UNAVAILABLE',
  /** The tenant's ledger lock was not obtained in time (503 + Retry-After). Nothing was stored. */
  LEDGER_BUSY: 'LEDGER_BUSY',
  /** A ledger or record rule refused the write, including a lost race (409): re-read, then decide. */
  LEDGER_CONFLICT: 'LEDGER_CONFLICT',
  /** The file is not one this build can read (422). */
  UNSUPPORTED_SOURCE: 'UNSUPPORTED_SOURCE',
  /**
   * The ledger watch found the record log damaged (503, no Retry-After: only an operator can clear it, by investigating and restarting).
   * Nothing was written; reads still work.
   */
  LEDGER_COMPROMISED: 'LEDGER_COMPROMISED',
  /** An installation fault, not the caller's doing (500): operator action. */
  PIPELINE_MISCONFIGURED: 'PIPELINE_MISCONFIGURED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export const errorCodeSchema = z.enum(Object.values(ErrorCode) as [ErrorCode, ...ErrorCode[]]);

/**
 * One field-level problem. Never contains the submitted value (it could be sensitive).
 * `reason` is a stable machine-readable word for a business conflict that shares a `code` (e.g. CONFLICT: `self-review`);
 * like `code`, it may be added to but never renamed.
 */
export const errorDetailSchema = z.strictObject({
  field: z.string(),
  message: z.string(),
  reason: z.string().optional(),
});
export type ErrorDetail = z.infer<typeof errorDetailSchema>;

/** The only error body the API returns. */
export const errorResponseSchema = z.strictObject({
  error: z.strictObject({
    code: errorCodeSchema,
    message: z.string(),
    details: z.array(errorDetailSchema).optional(),
    requestId: z.string(),
  }),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
