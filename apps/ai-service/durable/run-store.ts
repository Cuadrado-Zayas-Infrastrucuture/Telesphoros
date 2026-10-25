import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Queryable } from '@telesphoros/jobs';
import type { Run, State } from '../src/contracts';
import type { ExplainContext, ExplainStore } from '../src/explain-contracts';
import type { TenantTransactions } from './postgres';

const stateSchema = z.enum(['admitted', 'queued', 'running', 'reviewing', 'repair-pending', 'release-pending', 'released', 'held', 'failed', 'cancelled', 'expired']);
const count = z.number().int().nonnegative().safe();
/** The run as the database reports it: the shape of `Run`, times in epoch milliseconds. */
const runSchema = z.strictObject({
  id: z.uuid(),
  tenantId: z.string().min(1).max(128),
  requesterRef: z.string().min(1).max(128),
  state: stateSchema,
  sequence: count,
  fence: count.min(1),
  admittedAt: count,
  monoAt: count,
  deadlineAt: count,
  profileDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});
const refusalSchema = z.enum(['INVALID_INPUT', 'NOT_AUTHORIZED', 'NOT_FOUND', 'STALE', 'INVALID_TRANSITION', 'DEADLINE', 'RATE_LIMITED']);
const decision = <T extends z.ZodType>(value: T) =>
  z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('ok'), value }), z.strictObject({ kind: z.literal('refused'), code: refusalSchema })]);
const admittedSchema = decision(z.strictObject({ kind: z.enum(['new', 'existing', 'conflict']), run: runSchema }));
const runDecision = decision(runSchema);
const maybeRunDecision = decision(runSchema.nullable());

/**
 * The durable store of an explanation run (migration 0049): the idempotency key, the fenced state and the deadline, in PostgreSQL. It implements the run's `ExplainStore` port, so
 * every method may reject and `runExplanation` treats a rejection as a hold. It is built for one identity (the organization and requester the binder will present a capability for);
 * the caller supplies its transactional tenant binder, and this adapter owns no pool and no credential.
 * What the database refuses as stale (the state, sequence or fence moved, the move is illegal, or the run is past its deadline, which the database decides) is `null` from `advance`, as the port says; every other refusal, a transport
 * error and an answer of the wrong shape reject. The idempotency key is hashed here, so the database never sees it; the request digest arrives already keyed.
 */
export class PostgresExplainStore implements ExplainStore {
  constructor(
    private readonly app: TenantTransactions,
    private readonly who: { tenantId: string; actor: string },
  ) {}

  /**
   * Every call is one short transaction. A row another transaction holds (lock_not_available, the 2 s lock timeout), a serialization failure or a deadlock is a busy store: the call
   * rejects with RUN_STORE_BUSY, which a caller may retry (with the same idempotency key, so a retry cannot start a second run). The isolation level is the default (READ COMMITTED),
   * which `agentic_explain_run_admit` relies on; do not raise it.
   */
  private async call<T>(sql: string, args: readonly unknown[], schema: z.ZodType<T>): Promise<T> {
    try {
      return await this.run(sql, args, schema);
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code === '55P03' || code === '40001' || code === '40P01') throw new Error('RUN_STORE_BUSY', { cause: error });
      throw error;
    }
  }
  private run<T>(sql: string, args: readonly unknown[], schema: z.ZodType<T>): Promise<T> {
    return this.app.withTenant(
      this.who.tenantId,
      async (db: Queryable) => {
        const result = await db.query(sql, [...args]);
        return schema.parse(result.rows[0]?.result);
      },
      { actor: this.who.actor },
    );
  }
  private fail(code: string): never {
    throw new Error(`RUN_STORE_${code}`);
  }

  async admit(
    key: string,
    tuple: string,
    context: ExplainContext,
    harnessVersion: string,
    _utc: number,
    mono: number,
  ): Promise<{ kind: 'new' | 'existing' | 'conflict'; run: Run }> {
    if (context.tenantId !== this.who.tenantId || context.requesterRef !== this.who.actor) this.fail('IDENTITY_MISMATCH');
    const keyHash = `sha256:${createHash('sha256').update(key, 'utf8').digest('hex')}`;
    const out = await this.call(
      'SELECT public.agentic_explain_run_admit($1::text, $2::text, $3::text, $4::bigint) AS result',
      [keyHash, tuple, harnessVersion, Math.floor(mono)],
      admittedSchema,
    );
    return out.kind === 'ok' ? out.value : this.fail(out.code);
  }
  async get(id: string): Promise<Run> {
    const out = await this.call('SELECT public.agentic_explain_run_get($1::uuid) AS result', [id], maybeRunDecision);
    if (out.kind === 'refused') return this.fail(out.code);
    return out.value ?? this.fail('NO_RUN');
  }
  async advance(expected: Run, state: State): Promise<Run | null> {
    const out = await this.call(
      'SELECT public.agentic_explain_run_advance($1::uuid, $2::jsonb, $3::text) AS result',
      [expected.id, JSON.stringify({ state: expected.state, sequence: expected.sequence, fence: expected.fence }), state],
      runDecision,
    );
    if (out.kind === 'ok') return out.value;
    if (out.code === 'STALE' || out.code === 'INVALID_TRANSITION' || out.code === 'NOT_FOUND' || out.code === 'DEADLINE') return null;
    return this.fail(out.code);
  }
}
