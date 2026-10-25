import { JobError, UNEXPECTED_ERROR_CODE, systemActor, type ClaimedJob, type JobDefinition, type JobQueue } from '@telesphoros/jobs';
import type { Logger } from './log';

/**
 * How long to wait after the `failures`-th claim in a row failed: twice the poll interval, doubling, at most 30 seconds, with up to 20% either way
 * so that workers that lost the database together do not all come back on the same tick. `random` is in [0, 1).
 */
export function claimBackoffMs(failures: number, pollMs: number, random: number = Math.random()): number {
  return Math.min(30_000, Math.round(pollMs * 2 ** Math.min(failures, 6) * (0.8 + 0.4 * random)));
}

export interface HandlerContext {
  job: ClaimedJob;
  /** `system:<job type>`: what the job records as `created_by`. Never a person (see packages/jobs/src/actor.ts). */
  actor: string;
  /** The worker holding the job: the database asks for it, with the job id, before it lets a handler act. */
  workerId: string;
  /** Aborted when the job times out, its lease is lost, or the worker is shutting down. A handler stops promptly when it is. */
  signal: AbortSignal;
}

export type Handler = (context: HandlerContext) => Promise<void>;

export interface RegisteredJob {
  definition: JobDefinition;
  handler: Handler;
}

export interface RunnerOptions {
  workerId: string;
  queue: JobQueue;
  jobs: readonly RegisteredJob[];
  concurrency: number;
  tenantCap: number;
  pollMs: number;
  drainSeconds: number;
  log: Logger;
}

interface Running {
  job: ClaimedJob;
  abort: AbortController;
  stopTimers: () => void;
  released: boolean;
  done: Promise<void>;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The claim loop. It claims up to its free capacity from the queue, runs each job's handler with a heartbeat that keeps the lease, and reports the outcome:
 * success, a retry or a dead letter (by the handler's error code), or - on shutdown - a release. Delivery is at-least-once: a handler may run again after
 * a crash or a lost lease, so it must be idempotent. This class never sees a payload value in its logs (the logger has no place for one).
 */
export class Runner {
  private readonly byType = new Map<string, RegisteredJob>();
  private readonly running = new Map<string, Running>();
  private readonly leaseSeconds: number;
  private stopping = false;
  private loopDone: Promise<void> | undefined;
  private wake: (() => void) | undefined;
  private lastSeenAt = 0;
  lastLoopAt = 0;

  constructor(private readonly options: RunnerOptions) {
    for (const job of options.jobs) this.byType.set(job.definition.type, job);
    if (this.byType.size === 0) throw new Error('A worker needs at least one job type.');
    // A claim lasts the shortest lease among the types this worker runs (a job's own limit is its timeout, not its lease: the heartbeat keeps the lease).
    this.leaseSeconds = Math.min(...options.jobs.map((j) => j.definition.leaseSeconds));
  }

  get activeCount(): number {
    return this.running.size;
  }
  get isStopping(): boolean {
    return this.stopping;
  }
  get types(): string[] {
    return [...this.byType.keys()].sort();
  }

  start(): void {
    if (this.loopDone) throw new Error('The runner is already started.');
    this.options.log('info', 'worker-started', { workerId: this.options.workerId, count: this.byType.size });
    this.loopDone = this.loop();
  }

  /** Stops claiming, lets running jobs finish for `drainSeconds`, then releases whatever is left (an attempt not made is not counted). */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.wake?.();
    await this.loopDone;
    const log = this.options.log;
    log('info', 'worker-draining', { workerId: this.options.workerId, running: this.running.size });
    await Promise.race([Promise.allSettled([...this.running.values()].map((r) => r.done)), wait(this.options.drainSeconds * 1000)]);
    const left = [...this.running.values()];
    for (const r of left) {
      r.released = true;
      r.stopTimers();
      r.abort.abort(new Error('shutdown'));
      try {
        const ok = await this.options.queue.release(r.job.id, this.options.workerId);
        log('info', 'job-released', { jobId: r.job.id, jobType: r.job.type, attempt: r.job.attempt, outcome: ok ? 'released' : 'not-held' });
      } catch {
        log('error', 'job-release-failed', { jobId: r.job.id, jobType: r.job.type, code: 'release-failed' });
      }
    }
    await Promise.race([Promise.allSettled(left.map((r) => r.done)), wait(2000)]);
    log('info', 'worker-stopped', { workerId: this.options.workerId });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        if (this.wake === wake) this.wake = undefined;
        resolve();
      };
      const timer = setTimeout(wake, ms);
      this.wake = wake;
    });
  }

  private async loop(): Promise<void> {
    const { queue, workerId, log, pollMs, concurrency, tenantCap } = this.options;
    let failures = 0;
    while (!this.stopping) {
      this.lastLoopAt = Date.now();
      let claimed = 0;
      const free = concurrency - this.running.size;
      try {
        if (Date.now() - this.lastSeenAt > 15_000) {
          await queue.workerSeen(workerId);
          this.lastSeenAt = Date.now();
        }
        if (free > 0) {
          const jobs = await queue.claim(workerId, { types: this.types, batch: Math.min(free, 50), tenantCap, leaseSeconds: this.leaseSeconds });
          claimed = jobs.length;
          for (const job of jobs) this.launch(job);
        }
        failures = 0;
      } catch {
        failures += 1;
        log('error', 'claim-failed', { workerId, code: 'queue-unavailable', count: failures });
        await this.sleep(claimBackoffMs(failures, pollMs));
        continue;
      }
      // A full batch means there is probably more: go again at once. Otherwise wait for the poll interval or for a job to finish.
      if (claimed > 0 && claimed >= free) continue;
      await this.sleep(pollMs);
    }
  }

  private launch(job: ClaimedJob): void {
    const registered = this.byType.get(job.type);
    const abort = new AbortController();
    const entry: Running = { job, abort, stopTimers: () => undefined, released: false, done: Promise.resolve() };
    this.running.set(job.id, entry);
    entry.done = this.execute(entry, registered).finally(() => {
      entry.stopTimers();
      this.running.delete(job.id);
      this.wake?.();
    });
  }

  private async execute(entry: Running, registered: RegisteredJob | undefined): Promise<void> {
    const { queue, workerId, log } = this.options;
    const { job, abort } = entry;
    const fields = { jobId: job.id, jobType: job.type, attempt: job.attempt };
    log('info', 'job-started', fields);

    let result: { ok: true } | { ok: false; code: string; retryable: boolean };
    if (!registered) {
      result = { ok: false, code: 'unknown-job-type', retryable: false };
    } else {
      const parsed = registered.definition.payload.safeParse(job.payload);
      if (!parsed.success) {
        result = { ok: false, code: 'invalid-payload', retryable: false };
      } else {
        const { definition } = registered;
        let timedOut = false;
        let timer: NodeJS.Timeout | undefined;
        // A handler that ignores its abort signal is abandoned when the timeout passes (it may still run; delivery is at-least-once), not waited for.
        const timeout = new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => {
            timedOut = true;
            abort.abort(new Error('timeout'));
            resolve('timeout');
          }, definition.timeoutSeconds * 1000);
        });
        const leaseMs = this.leaseSeconds * 1000;
        let lastOk = Date.now();
        const beat = setInterval(
          () => {
            void (async () => {
              try {
                if (await queue.heartbeat(job.id, workerId, this.leaseSeconds)) {
                  lastOk = Date.now();
                  return;
                }
                log('warn', 'lease-lost', fields);
                abort.abort(new Error('lease-lost'));
              } catch {
                log('warn', 'heartbeat-failed', { ...fields, code: 'queue-unavailable' });
                if (Date.now() - lastOk > leaseMs) abort.abort(new Error('lease-lost'));
              }
            })();
          },
          Math.max(1000, (leaseMs / 3) | 0),
        );
        entry.stopTimers = () => {
          clearTimeout(timer);
          clearInterval(beat);
        };
        const handling = Promise.resolve().then(() => registered.handler({ job, actor: systemActor(job.type), workerId, signal: abort.signal }));
        handling.catch(() => undefined); // an abandoned handler's late failure is not an unhandled rejection
        try {
          await Promise.race([handling, timeout.then(() => Promise.reject(new Error('timeout')))]);
          result = { ok: true };
        } catch (error) {
          if (timedOut) result = { ok: false, code: 'handler-timeout', retryable: true };
          else if (error instanceof JobError) result = { ok: false, code: error.code, retryable: error.retryable };
          else result = { ok: false, code: UNEXPECTED_ERROR_CODE, retryable: true };
        } finally {
          entry.stopTimers();
        }
      }
    }

    if (entry.released) return; // shutdown released it; the result belongs to whoever runs it next
    await this.settle(job, result);
  }

  /** Reports the outcome, retrying a few times if the database is briefly unavailable (the lease protects the job if it stays so). */
  private async settle(job: ClaimedJob, result: { ok: true } | { ok: false; code: string; retryable: boolean }): Promise<void> {
    const { queue, workerId, log } = this.options;
    const fields = { jobId: job.id, jobType: job.type, attempt: job.attempt };
    for (let tryNumber = 0; tryNumber < 4; tryNumber += 1) {
      try {
        if (result.ok) {
          const held = await queue.succeed(job.id, workerId);
          log(held ? 'info' : 'warn', 'job-finished', { ...fields, outcome: held ? 'succeeded' : 'not-held' });
        } else {
          const state = await queue.fail(job.id, workerId, result.code, result.retryable);
          log(state === 'dead' ? 'error' : 'warn', 'job-finished', { ...fields, outcome: state ?? 'not-held', code: result.code });
        }
        return;
      } catch {
        log('error', 'job-report-failed', { ...fields, code: 'queue-unavailable', count: tryNumber + 1 });
        await wait(500 * 2 ** tryNumber);
      }
    }
  }
}
