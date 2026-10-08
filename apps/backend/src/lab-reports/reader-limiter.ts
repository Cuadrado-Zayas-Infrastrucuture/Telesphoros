import { AppException } from '../common/app-exception';

/**
 * Caps how many reads of report text run at once IN THIS PROCESS. It is not a deployment-wide or per-tenant limit (a multi-instance
 * deployment needs a shared one). Over the cap: an immediate 503 PIPELINE_BUSY and nothing is queued. The slot is released on every
 * exit path, including a throw, so a failing reader cannot leak capacity.
 */
export class ReaderLimiter {
  private running = 0;

  constructor(private readonly max: number) {
    if (!Number.isInteger(max) || max < 1) throw new RangeError('The reader limit must be a positive integer.');
  }

  get active(): number {
    return this.running;
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.running >= this.max) throw AppException.pipelineBusy();
    this.running++;
    try {
      return await work();
    } finally {
      this.running--;
    }
  }
}
