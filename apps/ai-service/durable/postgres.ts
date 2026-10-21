import { z } from 'zod';
import type { Queryable } from '@telesphoros/jobs';
import { outcomeSchema, utf8Length, type Outcome, type Source, type State } from '../src/contracts';
import { admissionSchema, decisionSchema, durableRequestSchema, durableSourceSchema, expectedSchema,
  fixtureCallerSchema, invocationSchema, runViewSchema, scriptedObservationSchema, stampSchema,
  terminalProposalSchema, type Admission, type Decision, type DurableSyntheticStore, type Expected,
  type FixtureCaller, type Invocation, type RunView, type ScriptedObservation, type Stamp,
  type TerminalProposal } from './contracts';

/** The caller supplies its existing transactional tenant binder. This adapter owns no pool or credential. */
export interface TenantTransactions {
  withTenant<T>(tenantId: string, work: (db: Queryable) => Promise<T>, options: { actor: string }): Promise<T>;
}

const sourcesSchema = z.array(durableSourceSchema).min(1).max(4)
  .refine(sources => sources.reduce((n, source) => n + utf8Length(source.body), 0) <= 16384);
const nullableOutcomeSchema = outcomeSchema.nullable();
const runIdSchema = z.uuid();

/** All calls are narrow, parameterized function calls; the SQL function is the security and transaction authority. */
export class PostgresSyntheticStore implements DurableSyntheticStore {
  constructor(private readonly workerDb: Queryable, private readonly app: TenantTransactions) {}

  private async call<T>(db: Queryable, name: string, args: readonly unknown[], valueSchema: z.ZodType<T>): Promise<Decision<T>> {
    const placeholders = args.map((_, i) => `$${i + 1}${i === 0 && (name === 'read' || name === 'cancel') ? '::uuid' : '::jsonb'}`).join(',');
    const sql = `SELECT public.agentic_synthetic_${name}(${placeholders}) AS result`;
    try {
      const result = await db.query(sql, [...args]);
      return decisionSchema(valueSchema).parse(result.rows[0]?.result);
    } catch {
      // A transport error can mean an ambiguous commit. The caller must reconcile by exact readback,
      // never retry an actor call or assume a transaction rolled back.
      return { kind: 'refused', code: 'STORAGE_UNAVAILABLE' };
    }
  }

  private worker<T>(name: string, schema: z.ZodType<T>, ...values: unknown[]): Promise<Decision<T>> {
    return this.call(this.workerDb, name, values.map(value => JSON.stringify(value)), schema);
  }

  private async appCall<T>(name: string, caller: FixtureCaller, schema: z.ZodType<T>, ...values: unknown[]): Promise<Decision<T>> {
    try {
      const trusted = fixtureCallerSchema.parse(caller);
      return await this.app.withTenant(trusted.tenantId, db => this.call(db, name,
        [...values, trusted].map((value, index) => index === 0 && name !== 'admit' ? value : JSON.stringify(value)), schema),
      { actor: trusted.requesterRef });
    } catch { return { kind: 'refused', code: 'STORAGE_UNAVAILABLE' }; }
  }

  async admit(input: unknown, caller: FixtureCaller): Promise<Decision<Admission>> {
    const parsed = durableRequestSchema.safeParse(input);
    if (!parsed.success || !fixtureCallerSchema.safeParse(caller).success) return { kind: 'refused', code: 'INVALID_INPUT' };
    return this.appCall('admit', caller, admissionSchema, parsed.data);
  }

  async load(stamp: Stamp, expected: Expected): Promise<Decision<RunView>> {
    if (!stampSchema.safeParse(stamp).success || !expectedSchema.safeParse(expected).success) return { kind: 'refused', code: 'INVALID_INPUT' };
    return this.worker('load', runViewSchema, stamp, expected);
  }

  async sources(stamp: Stamp, expected: Expected): Promise<Decision<readonly Source[]>> {
    if (!stampSchema.safeParse(stamp).success || !expectedSchema.safeParse(expected).success) return { kind: 'refused', code: 'INVALID_INPUT' };
    return this.worker('sources', sourcesSchema, stamp, expected);
  }

  async advance(stamp: Stamp, expected: Expected, next: State): Promise<Decision<RunView>> {
    if (!stampSchema.safeParse(stamp).success || !expectedSchema.safeParse(expected).success || !runViewSchema.shape.state.safeParse(next).success)
      return { kind: 'refused', code: 'INVALID_INPUT' };
    // p_next is text, unlike the other JSON fragments.
    try {
      const result = await this.workerDb.query('SELECT public.agentic_synthetic_advance($1::jsonb,$2::jsonb,$3::text) AS result',
        [JSON.stringify(stamp), JSON.stringify(expected), next]);
      return decisionSchema(runViewSchema).parse(result.rows[0]?.result);
    } catch { return { kind: 'refused', code: 'STORAGE_UNAVAILABLE' }; }
  }

  async begin(stamp: Stamp, expected: Expected, invocation: Invocation): Promise<Decision<RunView>> {
    if (!stampSchema.safeParse(stamp).success || !expectedSchema.safeParse(expected).success || !invocationSchema.safeParse(invocation).success)
      return { kind: 'refused', code: 'INVALID_INPUT' };
    return this.worker('begin', runViewSchema, stamp, expected, invocation);
  }

  async observe(stamp: Stamp, expected: Expected, receipt: ScriptedObservation): Promise<Decision<RunView>> {
    if (!stampSchema.safeParse(stamp).success || !expectedSchema.safeParse(expected).success || !scriptedObservationSchema.safeParse(receipt).success)
      return { kind: 'refused', code: 'INVALID_INPUT' };
    return this.worker('observe', runViewSchema, stamp, expected, receipt);
  }

  async finish(stamp: Stamp, expected: Expected, proposal: TerminalProposal): Promise<Decision<Outcome>> {
    if (!stampSchema.safeParse(stamp).success || !expectedSchema.safeParse(expected).success || !terminalProposalSchema.safeParse(proposal).success)
      return { kind: 'refused', code: 'INVALID_INPUT' };
    return this.worker('finish', outcomeSchema, stamp, expected, proposal);
  }

  async read(runId: string, caller: FixtureCaller): Promise<Decision<Outcome | null>> {
    if (!runIdSchema.safeParse(runId).success || !fixtureCallerSchema.safeParse(caller).success) return { kind: 'refused', code: 'INVALID_INPUT' };
    return this.appCall('read', caller, nullableOutcomeSchema, runId);
  }

  async cancel(runId: string, caller: FixtureCaller): Promise<Decision<Outcome>> {
    if (!runIdSchema.safeParse(runId).success || !fixtureCallerSchema.safeParse(caller).success) return { kind: 'refused', code: 'INVALID_INPUT' };
    return this.appCall('cancel', caller, outcomeSchema, runId);
  }
}
