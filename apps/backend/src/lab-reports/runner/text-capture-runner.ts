/** Text read from one PDF, and the Poppler version that produced it. */
export interface TextCapture {
  text: string;
  popplerVersion: string;
}

/**
 * Turns the retrieved bytes of a stored PDF into text. The runner hashes the bytes it is given itself: it is never told what the
 * hash "should" be, so a caller (or a replaced file) cannot borrow another file's result.
 */
export abstract class TextCaptureRunner {
  abstract readonly name: 'fake' | 'poppler';
  abstract capture(pdf: Buffer): Promise<TextCapture>;
}

/** A fact about this file: no runner can read it. User-facing (422 UNSUPPORTED_SOURCE). Nothing is retried. */
export class UnsupportedSourceError extends Error {
  constructor() {
    super('This file is not one the runner can read.');
    this.name = 'UnsupportedSourceError';
  }
}

/** An installation fault, not the caller's doing (500 PIPELINE_MISCONFIGURED). `code` is the only detail; it never contains a path or text. */
export class RunnerMisconfiguredError extends Error {
  constructor(readonly code: string) {
    super('The text runner is not installed correctly.');
    this.name = 'RunnerMisconfiguredError';
  }
}
