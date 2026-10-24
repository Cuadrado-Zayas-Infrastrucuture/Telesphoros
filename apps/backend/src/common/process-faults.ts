import { writeSync } from 'node:fs';

type FaultKind = 'uncaughtException' | 'unhandledRejection';

export interface ProcessFaultTarget {
  on(event: FaultKind, listener: (error: unknown) => void): unknown;
}

export interface ProcessFaultOptions {
  /** Which process this is, so one alarm can tell the API from the worker. */
  service: string;
  /** One line to stderr by default. Never throws out of the handler. */
  write?: (line: string) => void;
  exit?: (code: number) => void;
}

const SHORT = /^[A-Za-z0-9._:-]{1,64}$/;

/**
 * A process that is about to die writes ONE structured line, then exits 1 so the orchestrator replaces it. Node's own default prints the error's message and stack,
 * and a thrown message can carry a value (a patient label, a digest), so this line names only the kind, the error CLASS and a short `code`; never the message, the
 * stack or any other property. The `process-fault` event is top-level so a log metric filter can alarm on it (infrastructure/terraform).
 */
export function installProcessFaultHandlers(target: ProcessFaultTarget, options: ProcessFaultOptions): void {
  const write = options.write ?? ((line: string) => void writeSync(2, line));
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let faulted = false;
  for (const kind of ['uncaughtException', 'unhandledRejection'] as const) {
    target.on(kind, (error: unknown) => {
      if (faulted) return;
      faulted = true;
      const name = error instanceof Error ? error.constructor?.name ?? error.name : undefined;
      const code = (error as { code?: unknown } | null | undefined)?.code;
      const line = JSON.stringify({
        level: 'fatal',
        time: Date.now(),
        service: options.service,
        event: 'process-fault',
        kind,
        errorClass: name !== undefined && SHORT.test(name) ? name : 'non-error',
        ...(typeof code === 'string' && SHORT.test(code) ? { code } : {}),
      });
      try {
        write(`${line}\n`);
      } catch {
        // nothing left to report to: the exit below is the point
      }
      exit(1);
    });
  }
}
