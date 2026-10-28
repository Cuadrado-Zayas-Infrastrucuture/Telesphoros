import { randomUUID } from 'node:crypto';
import { systemActor } from './actor';
import { JobError, UNEXPECTED_ERROR_CODE } from './errors';
import type { Logger } from './log';
import type { ClaimedJob, JobQueue } from './queue';
import type { JobDefinition } from './registry';

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
  /** The holder of this attempt (`<worker id>#<8 hex>`, new on every claim): the database asks for it, with the job id, before it lets a handler act. */
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
  /** Who the database recorded as holding this attempt; a later claim of the same job has another, so this attempt's calls are refused once it is reclaimed. */
  holder: string;
  abort: AbortController;
  stopTimers: () => void;
  released: boolean;
  /** Past its handler and reporting the outcome: shutdown waits for it rather than release it (a released finished job would run again, its attempt not counted). */
  settling: boolean;
  /** The outcome was never recorded: `settle()` gave up, and lease expiry will recover the job. */
  unsettled: boolean;
  done: Promise<void>;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** How long a stop waits for outcomes still being reported: longer than `settle()`'s retries (7.5 seconds), within the shutdown grace (apps/worker/src/shutdown.ts). */
const SETTLE_WAIT_MS = 8000;

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

  /**
   * Stops claiming, lets running jobs finish for `drainSeconds`, then releases whatever is left (an attempt not made is not counted) and waits for outcomes still being
   * reported. Throws `shutdown-incomplete` when a release failed or an outcome was not recorded, so the process exits 1: lease expiry recovers those jobs, as after a crash.
   */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.wake?.();
    await this.loopDone;
    const log = this.options.log;
    log('info', 'worker-draining', { workerId: this.options.workerId, running: this.running.size });
    await Promise.race([Promise.allSettled([...this.running.values()].map((r) => r.done)), wait(this.options.drainSeconds * 1000)]);
    const left = [...this.running.values()];
    let incomplete = 0;
    for (const r of left) {
      if (r.settling) continue;
      r.released = true;
      r.stopTimers();
      r.abort.abort(new Error('shutdown'));
      try {
        const ok = await this.options.queue.release(r.job.id, r.holder);
        log('info', 'job-released', { jobId: r.job.id, jobType: r.job.type, attempt: r.job.attempt, outcome: ok ? 'released' : 'not-held' });
      } catch {
        incomplete += 1;
        log('error', 'job-release-failed', { jobId: r.job.id, jobType: r.job.type, code: 'release-failed' });
      }
    }
    await Promise.race([Promise.allSettled(left.map((r) => r.done)), wait(left.some((r) => r.settling) ? SETTLE_WAIT_MS : 2000)]);
    incomplete += left.filter((r) => r.settling && (r.unsettled || this.running.get(r.job.id) === r)).length;
    log(incomplete ? 'error' : 'info', 'worker-stopped', { workerId: this.options.workerId, ...(incomplete ? { count: incomplete } : {}) });
    if (incomplete) throw new Error('shutdown-incomplete');
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
          // A holder per claim, not the bare worker id: when this worker claims its own expired job again, the database tells the two attempts apart (audit W2).
          // The worker id stays the prefix, so `jobs show` and the attempt log still name the worker.
          const holder = `${workerId}#${randomUUID().slice(0, 8)}`;
          const jobs = await queue.claim(holder, { types: this.types, batch: Math.min(free, 50), tenantCap, leaseSeconds: this.leaseSeconds });
          claimed = jobs.length;
          for (const job of jobs) this.launch(job, holder);
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

  private launch(job: ClaimedJob, holder: string): void {
    const registered = this.byType.get(job.type);
    // This worker claimed a job it still runs (its lease ran out first): the old attempt is no longer held, so stop it rather than let both run.
    const previous = this.running.get(job.id);
    if (previous) {
      previous.stopTimers();
      previous.abort.abort(new Error('lease-lost'));
    }
    const abort = new AbortController();
    const entry: Running = { job, holder, abort, stopTimers: () => undefined, released: false, settling: false, unsettled: false, done: Promise.resolve() };
    this.running.set(job.id, entry);
    entry.done = this.execute(entry, registered).finally(() => {
      entry.stopTimers();
      if (this.running.get(job.id) === entry) this.running.delete(job.id);
      this.wake?.();
    });
  }

  private async execute(entry: Running, registered: RegisteredJob | undefined): Promise<void> {
    const { queue, log } = this.options;
    const { job, holder, abort } = entry;
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
                if (await queue.heartbeat(job.id, holder, this.leaseSeconds)) {
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
        const handling = Promise.resolve().then(() => registered.handler({ job, actor: systemActor(job.type), workerId: holder, signal: abort.signal }));
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
    entry.settling = true;
    entry.unsettled = !(await this.settle(job, holder, result));
  }

  /** Reports the outcome, retrying a few times if the database is briefly unavailable (the lease protects the job if it stays so). */
  private async settle(job: ClaimedJob, holder: string, result: { ok: true } | { ok: false; code: string; retryable: boolean }): Promise<boolean> {
    const { queue, log } = this.options;
    const fields = { jobId: job.id, jobType: job.type, attempt: job.attempt };
    for (let tryNumber = 0; tryNumber < 4; tryNumber += 1) {
      try {
        if (result.ok) {
          const held = await queue.succeed(job.id, holder);
          log(held ? 'info' : 'warn', 'job-finished', { ...fields, outcome: held ? 'succeeded' : 'not-held' });
        } else {
          const state = await queue.fail(job.id, holder, result.code, result.retryable);
          log(state === 'dead' ? 'error' : 'warn', 'job-finished', { ...fields, outcome: state ?? 'not-held', code: result.code });
        }
        return true;
      } catch {
        log('error', 'job-report-failed', { ...fields, code: 'queue-unavailable', count: tryNumber + 1 });
        await wait(500 * 2 ** tryNumber);
      }
    }
    return false;
  }
}
