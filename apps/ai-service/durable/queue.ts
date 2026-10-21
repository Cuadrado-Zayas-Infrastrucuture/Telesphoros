import { JobQueue, type ClaimedJob, type ClaimOptions, type Queryable } from '@telesphoros/jobs';
import { z } from 'zod';
import { decisionSchema, expectedSchema, stampSchema, SYNTHETIC_JOB_TYPE, type Expected, type Stamp } from './contracts';

const payloadSchema = z.strictObject({ runId: z.uuid() });
const controlSchema = decisionSchema(z.union([z.boolean(), z.literal('dead'), z.null()]));

/** Extra claim data is private to the test harness; Runner receives only ClaimedJob fields. */
export class SyntheticJobQueue extends JobQueue {
  private readonly stamps = new Map<string, { stamp: Stamp; expected: Expected }>();

  constructor(private readonly syntheticDb: Queryable) { super(syntheticDb); }

  override async claim(workerId: string, options: ClaimOptions): Promise<ClaimedJob[]> {
    if (options.types.length !== 1 || options.types[0] !== SYNTHETIC_JOB_TYPE ||
      !Number.isInteger(options.batch) || options.batch < 1 || options.batch > 2 ||
      options.tenantCap !== 1 || options.leaseSeconds !== 15 || typeof workerId !== 'string' ||
      workerId.length < 1 || workerId.length > 128 || !workerId.isWellFormed() || workerId.includes('\u0000')) {
      throw new Error('INVALID_INPUT');
    }
    const result = await this.syntheticDb.query('SELECT * FROM public.agentic_synthetic_claim($1,$2)', [workerId, options.batch]);
    if (result.rows.length > options.batch) throw new Error('STORAGE_UNAVAILABLE');
    const pending: { job: ClaimedJob; stamp: Stamp; expected: Expected }[] = [];
    const seen = new Set<string>();
    for (const row of result.rows) {
      const payload = payloadSchema.parse(row.payload);
      const stamp = stampSchema.parse({ jobId: row.id, runId: row.run_id, workerId,
        queueAttempt: Number(row.attempt), claimId: row.claim_id, fence: String(row.fence) });
      const expected = expectedSchema.parse({ sequence: String(row.sequence), state: row.state });
      if (row.type !== SYNTHETIC_JOB_TYPE || row.run_id !== payload.runId ||
        typeof row.tenant_id !== 'string' || !row.tenant_id ||
        typeof row.requested_by !== 'string' || !row.requested_by ||
        this.stamps.has(stamp.jobId) || seen.has(stamp.jobId)) throw new Error('STALE_CLAIM');
      const leaseUntil = row.lease_until instanceof Date ? row.lease_until : new Date(String(row.lease_until));
      if (!Number.isFinite(leaseUntil.getTime())) throw new Error('STORAGE_UNAVAILABLE');
      const maxAttempts = Number(row.max_attempts);
      if (maxAttempts !== 1) throw new Error('STORAGE_UNAVAILABLE');
      seen.add(stamp.jobId);
      pending.push({ job: { id: stamp.jobId, tenantId: row.tenant_id, type: SYNTHETIC_JOB_TYPE,
        payload, attempt: stamp.queueAttempt, maxAttempts, leaseUntil, requestedBy: row.requested_by }, stamp, expected });
    }
    for (const item of pending) this.stamps.set(item.stamp.jobId, Object.freeze({
      stamp: Object.freeze(item.stamp), expected: Object.freeze(item.expected),
    }));
    return pending.map(item => item.job);
  }

  claimFor(jobId: string, workerId: string): Readonly<{ stamp: Stamp; expected: Expected }> | null {
    const entry = this.stamps.get(jobId);
    return entry?.stamp.workerId === workerId ? entry : null;
  }

  private async control(jobId: string, workerId: string, operation: 'heartbeat' | 'succeed' | 'fail' | 'release', code: string | null = null): Promise<boolean | 'dead' | null> {
    const entry = this.claimFor(jobId, workerId);
    if (!entry) return null;
    const response = await this.syntheticDb.query('SELECT public.agentic_synthetic_queue_control($1::jsonb,$2,$3) AS result',
      [JSON.stringify(entry.stamp), operation, code]);
    const parsed = controlSchema.parse(response.rows[0]?.result);
    return parsed.kind === 'ok' ? parsed.value : null;
  }

  override async heartbeat(jobId: string, workerId: string, leaseSeconds: number): Promise<boolean> {
    if (leaseSeconds !== 15) return false;
    return await this.control(jobId, workerId, 'heartbeat') === true;
  }

  override async succeed(jobId: string, workerId: string): Promise<boolean> {
    return await this.control(jobId, workerId, 'succeed') === true;
  }

  override async fail(jobId: string, workerId: string, code: string, retryable: boolean): Promise<'dead' | undefined> {
    if (typeof retryable !== 'boolean' || !/^[a-z][a-z0-9-]{0,63}$/.test(code)) throw new Error('INVALID_INPUT');
    // The existing Runner can ask for a retry; the fixture boundary always passes a nonretryable operation.
    return await this.control(jobId, workerId, 'fail', code) === 'dead' ? 'dead' : undefined;
  }

  override async release(jobId: string, workerId: string): Promise<boolean> {
    return await this.control(jobId, workerId, 'release') === true;
  }

  override async scheduleTick(): Promise<number> { throw new Error('INVALID_INPUT'); }
  override async relayOutbox(): Promise<number> { throw new Error('INVALID_INPUT'); }
}
