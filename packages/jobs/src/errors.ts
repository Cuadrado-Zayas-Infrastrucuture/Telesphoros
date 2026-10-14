/** An error code is a short code: letters, digits and hyphens, starting with a letter. Never a message, never a value from a record. */
export const ERROR_CODE = /^[a-z][a-z0-9-]{1,47}$/;

/**
 * How a handler says it failed. `retryable` failures are tried again with backoff until the job's attempts are used up; the others make the job dead at once
 * (it is kept and visible, and only a person re-queues it). Anything else a handler throws is treated as a retryable `handler-error`.
 */
export class JobError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, retryable: boolean) {
    if (!ERROR_CODE.test(code)) throw new Error('A job error code is a short code.');
    super(code);
    this.name = 'JobError';
    this.code = code;
    this.retryable = retryable;
  }
}

export const retryable = (code: string) => new JobError(code, true);
export const fatal = (code: string) => new JobError(code, false);

/** The code a thrown non-JobError becomes. */
export const UNEXPECTED_ERROR_CODE = 'handler-error';
