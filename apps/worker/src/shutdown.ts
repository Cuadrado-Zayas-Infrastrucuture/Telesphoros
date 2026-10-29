import { boundedStop } from '@telesphoros/jobs';
import type { Logger } from './log';

// The deadline and the bounded sequence are shared with the backend's evaluation worker, so they live in @telesphoros/jobs.
export { SHUTDOWN_GRACE_SECONDS, shutdownDeadlineMs } from '@telesphoros/jobs';

export interface Stoppable {
  stop(): Promise<void>;
}

export interface ShutdownParts {
  /** Closes the health listener (synchronous). */
  closeHealth(): void;
  /** Stopped together, before the runner. */
  tickers: Stoppable[];
  runner: Stoppable;
  closePool(): Promise<void>;
  log: Logger;
  exit(code: number): void;
  deadlineMs: number;
}

/** The file worker's stop sequence: the health listener, the tickers, the runner, then the pool, bounded by `boundedStop`. */
export function createShutdown(parts: ShutdownParts): (signal: string) => Promise<void> {
  return boundedStop({
    steps: [
      { name: 'health', run: () => parts.closeHealth() },
      { name: 'tickers', run: () => Promise.all(parts.tickers.map((t) => t.stop())) },
      { name: 'runner', run: () => parts.runner.stop() },
      { name: 'pool', run: () => parts.closePool() },
    ],
    log: parts.log,
    exit: parts.exit,
    deadlineMs: parts.deadlineMs,
  });
}
