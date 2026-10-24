import type { Logger } from './log';

type FaultKind = 'uncaughtException' | 'unhandledRejection';

export interface ProcessFaultTarget {
  on(event: FaultKind, listener: (error: unknown) => void): unknown;
}

/**
 * A worker about to die writes ONE `process-fault` line, then exits 1 so the orchestrator replaces it. Node's own default prints the error's message and stack, and a
 * thrown message can carry a value, so the line names only the kind and the error CLASS, through the worker's allowlisted logger (which drops any string that is not a
 * short code anyway). A log metric filter on `process-fault` raises the alarm (infrastructure/terraform/worker.tf).
 */
export function installProcessFaultHandlers(target: ProcessFaultTarget, log: Logger, exit: (code: number) => void = (code) => process.exit(code)): void {
  let faulted = false;
  for (const kind of ['uncaughtException', 'unhandledRejection'] as const) {
    target.on(kind, (error: unknown) => {
      if (faulted) return;
      faulted = true;
      try {
        log('error', 'process-fault', { reason: kind, code: error instanceof Error ? (error.constructor?.name ?? error.name) : 'non-error' });
      } catch {
        // nothing left to report to: the exit below is the point
      }
      exit(1);
    });
  }
}
