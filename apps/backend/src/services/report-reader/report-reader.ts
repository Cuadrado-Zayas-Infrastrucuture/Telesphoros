import type { ReaderResult } from './reader-result';

/**
 * Reads one stored report text and returns where genes and values are in it. Implementations never decide what a value
 * means and never fail by throwing for a report they cannot handle: they return a `held` result with a reason. A throw
 * means the caller misused the reader or it was misconfigured, or the caller cancelled the read.
 */
export interface ReportReader {
  read(text: string, options?: ReadOptions): Promise<ReaderResult>;
}

export interface ReadOptions {
  /**
   * Cancels the read. A cancelled read rejects with the signal's reason (it is the caller's decision, not a fact about the text, so it is
   * never a `held` result), and only after anything it started has stopped.
   */
  signal?: AbortSignal;
}

/** Thrown when the reader is configured in a way that is not allowed (for example, started in production). */
export class ReaderNotApprovedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReaderNotApprovedError';
  }
}

/**
 * Where reader problems go. Compatible with nestjs-pino's PinoLogger (object first, then message). Fields are only ever
 * codes, counts, exit codes and exception class names: never report text.
 */
export interface ReaderLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}
