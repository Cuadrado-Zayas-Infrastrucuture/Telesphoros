import type { Logger } from './log';

/** Extra seconds beyond the drain that a stop signal may take before the process gives up and exits. Must stay below the container's stop timeout (worker.tf). */
export const SHUTDOWN_GRACE_SECONDS = 15;

/** The longest a stop may take: the drain, then releasing what is left, then closing the pool. */
export const shutdownDeadlineMs = (drainSeconds: number): number => (drainSeconds + SHUTDOWN_GRACE_SECONDS) * 1000;

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

/**
 * The worker's stop sequence, bounded: if any step waits (a query to a database that has stopped answering, a handler that ignores its abort signal), the process
 * logs `shutdown-forced` and exits 1 at the deadline instead of waiting for the container runtime to kill it. A leased job it did not release is then recovered by
 * lease expiry, the same as after a crash. A step that throws is logged and does not stop the later steps; the exit code is then 1.
 */
export function createShutdown(parts: ShutdownParts): (signal: string) => Promise<void> {
  let stopping = false;
  return async (signal: string) => {
    if (stopping) return;
    stopping = true;
    const { log } = parts;
    log('info', 'shutdown-requested', { reason: signal });
    const timer = setTimeout(() => {
      log('error', 'shutdown-forced', { reason: 'deadline', count: Math.round(parts.deadlineMs / 1000) });
      parts.exit(1);
    }, parts.deadlineMs);
    let failed = false;
    const step = async (name: string, work: () => Promise<unknown> | void) => {
      try {
        await work();
      } catch {
        failed = true;
        log('error', 'shutdown-step-failed', { code: name });
      }
    };
    await step('health', () => {
      parts.closeHealth();
    });
    await step('tickers', () => Promise.all(parts.tickers.map((t) => t.stop())));
    await step('runner', () => parts.runner.stop());
    await step('pool', () => parts.closePool());
    clearTimeout(timer);
    parts.exit(failed ? 1 : 0);
  };
}
