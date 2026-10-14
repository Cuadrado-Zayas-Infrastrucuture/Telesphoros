import type { JobDefinition } from './registry';
import { assertFlatPayload } from './registry';

/** The part of a database connection the queue needs (a `pg` Client, PoolClient or Pool satisfies it). */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}

export interface ClaimedJob {
  id: string;
  tenantId: string;
  type: string;
  payload: Record<string, unknown>;
  /** 1-based number of this run. */
  attempt: number;
  maxAttempts: number;
  leaseUntil: Date;
  requestedBy: string;
}

export interface ClaimOptions {
  types: string[];
  batch: number;
  /** At most this many running jobs for one organization at a time. */
  tenantCap: number;
  leaseSeconds: number;
}

export interface JobStat {
  type: string;
  state: string;
  count: number;
  oldestReadySeconds: number | null;
}

/**
 * The worker's side of the queue: every call is one SQL function of migration 0023 (the worker login can call nothing else on the queue).
 * All of them are safe to repeat, and none can act on a job another worker holds.
 */
export class JobQueue {
  constructor(private readonly db: Queryable) {}

  async claim(workerId: string, options: ClaimOptions): Promise<ClaimedJob[]> {
    const { rows } = await this.db.query('SELECT * FROM job_claim($1, $2::text[], $3, $4, $5)', [workerId, options.types, options.batch, options.tenantCap, options.leaseSeconds]);
    return rows.map((r) => ({
      id: r.id as string, tenantId: r.tenant_id as string, type: r.type as string, payload: r.payload as Record<string, unknown>, attempt: Number(r.attempt),
      maxAttempts: Number(r.max_attempts), leaseUntil: r.lease_until as Date, requestedBy: r.requested_by as string,
    }));
  }

  /** False means the lease was lost: stop working on the job. */
  async heartbeat(jobId: string, workerId: string, leaseSeconds: number): Promise<boolean> {
    return (await this.db.query('SELECT job_heartbeat($1, $2, $3) AS ok', [jobId, workerId, leaseSeconds])).rows[0]!.ok === true;
  }

  async succeed(jobId: string, workerId: string): Promise<boolean> {
    return (await this.db.query('SELECT job_succeed($1, $2) AS ok', [jobId, workerId])).rows[0]!.ok === true;
  }

  /** The new state (`retry` or `dead`), or undefined when this worker no longer holds the job. */
  async fail(jobId: string, workerId: string, code: string, retryable: boolean): Promise<'retry' | 'dead' | undefined> {
    const state = (await this.db.query('SELECT job_fail($1, $2, $3, $4) AS state', [jobId, workerId, code, retryable])).rows[0]!.state as string | null;
    return state === null ? undefined : (state as 'retry' | 'dead');
  }

  async release(jobId: string, workerId: string): Promise<boolean> {
    return (await this.db.query('SELECT job_release($1, $2) AS ok', [jobId, workerId])).rows[0]!.ok === true;
  }

  /** Enqueues one job per active organization for every enabled schedule whose slot has not been enqueued yet. Returns how many were new. */
  async scheduleTick(now?: Date): Promise<number> {
    return Number((await this.db.query('SELECT job_schedule_tick($1) AS n', [now ?? new Date()])).rows[0]!.n);
  }

  /** Turns pending outbox events into jobs, and marks them, in one transaction. Returns how many jobs were created. */
  async relayOutbox(batch = 50): Promise<number> {
    return Number((await this.db.query('SELECT outbox_relay($1) AS n', [batch])).rows[0]!.n);
  }

  async workerSeen(workerId: string): Promise<void> {
    await this.db.query('SELECT job_worker_seen($1)', [workerId]);
  }

  async stats(): Promise<JobStat[]> {
    const { rows } = await this.db.query('SELECT * FROM job_stats()');
    return rows.map((r) => ({ type: r.type as string, state: r.state as string, count: Number(r.n), oldestReadySeconds: r.oldest_ready_seconds === null ? null : Number(r.oldest_ready_seconds) }));
  }
}

export interface EnqueueOptions {
  /** The same key for the same intended job: a repeat returns the existing job. Letters, digits, `:`, `_` and `-`, at most 96. */
  idempotencyKey: string;
  runAfter?: Date;
  maxAttempts?: number;
}

/**
 * The API's side: enqueue inside the transaction that holds the business change (so a rolled-back change leaves no job). `db` must be a client inside
 * `Database.withTenant`, which binds the organization and the person; the database function takes both from there, never from arguments.
 */
export async function enqueueJob(db: Queryable, definition: JobDefinition, payload: unknown, options: EnqueueOptions): Promise<{ jobId: string; created: boolean }> {
  const parsed = definition.payload.parse(payload);
  assertFlatPayload(parsed);
  const { rows } = await db.query('SELECT job_id, created FROM job_enqueue($1, $2::jsonb, $3, $4, $5)', [
    definition.type, JSON.stringify(parsed), options.idempotencyKey, options.runAfter ?? new Date(), options.maxAttempts ?? definition.maxAttempts,
  ]);
  return { jobId: rows[0]!.job_id as string, created: rows[0]!.created === true };
}
