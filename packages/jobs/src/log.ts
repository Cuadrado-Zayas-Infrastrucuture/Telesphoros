/**
 * A job runner's only way to write a log line. The fields are a fixed list of ids, counts and codes: there is no place to put a payload value, a message from a
 * thrown error or a record's content, so a handler cannot leak one through the log by accident.
 */
export interface LogFields {
  workerId?: string;
  jobId?: string;
  jobType?: string;
  /** The id of the API request that caused the job, when the job carries one. A short code like any other string here. */
  requestId?: string;
  attempt?: number;
  outcome?: string;
  code?: string;
  count?: number;
  running?: number;
  /** Seconds the oldest ready job has waited (the queue-not-draining alarm reads it). */
  ageSeconds?: number;
  dead?: number;
  /** Outbox events not yet turned into jobs, and the seconds the oldest has waited (the outbox-stuck alarm reads the age). */
  outboxPending?: number;
  outboxAgeSeconds?: number;
  reason?: string;
}

export type Logger = (level: 'info' | 'warn' | 'error', event: string, fields?: LogFields) => void;

const SHORT = /^[A-Za-z0-9._:-]{1,96}$/;

export function jsonLogger(write: (line: string) => void = (line) => process.stdout.write(`${line}\n`), service = 'worker'): Logger {
  return (level, event, fields = {}) => {
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      // A string that is not a short code is dropped rather than written.
      if (typeof value === 'string' && !SHORT.test(value)) continue;
      safe[key] = value;
    }
    write(JSON.stringify({ time: new Date().toISOString(), level, service, event, ...safe }));
  };
}

export const silentLogger: Logger = () => undefined;
