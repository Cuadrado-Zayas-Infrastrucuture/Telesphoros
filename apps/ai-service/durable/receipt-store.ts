import { z } from 'zod';
import type { Queryable } from '@telesphoros/jobs';
import { outcomeV2Schema, type OutcomeV2 } from '../src/outcome-v2';
import type { TenantTransactions } from './postgres';

/** The database answers `{kind:'ok',value}` or `{kind:'refused',code}`; these are the refusals of the two receipt functions, plus the adapter's own. */
export const receiptRefusalSchema = z.enum(['INVALID_INPUT', 'NOT_AUTHORIZED', 'DUPLICATE', 'RATE_LIMITED', 'STORAGE_UNAVAILABLE']);
export type ReceiptRefusal = z.infer<typeof receiptRefusalSchema>;
export type ReceiptDecision<T> = Readonly<{ kind: 'ok'; value: T } | { kind: 'refused'; code: ReceiptRefusal }>;
const decision = <T extends z.ZodType>(value: T) =>
  z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('ok'), value }), z.strictObject({ kind: z.literal('refused'), code: receiptRefusalSchema })]);
const appended = decision(z.strictObject({ receiptId: z.uuid() }));
const readBack = decision(outcomeV2Schema.nullable());

/**
 * Stores the receipt of an explanation run (migration 0048; append and read only: the purge is an operator function that no login can run). The caller supplies its transactional tenant binder, which presents the capability; this adapter owns no
 * pool and no credential. A receipt is checked against outcome v2 before the database is called, so a shape with text in it never leaves the process; the database
 * checks it again (the table has no column that can hold text). Every call is one parameterized function call. A transport error is `STORAGE_UNAVAILABLE`, which can mean
 * an ambiguous commit: the caller reconciles by reading the run back, and never assumes the write did not happen.
 */
export class PostgresReceiptStore {
  constructor(private readonly app: TenantTransactions) {}

  private async call<T>(tenantId: string, actor: string, sql: string, args: readonly unknown[], schema: z.ZodType<ReceiptDecision<T>>): Promise<ReceiptDecision<T>> {
    try {
      return await this.app.withTenant(
        tenantId,
        async (db: Queryable) => {
          const result = await db.query(sql, [...args]);
          return schema.parse(result.rows[0]?.result);
        },
        { actor },
      );
    } catch {
      return { kind: 'refused', code: 'STORAGE_UNAVAILABLE' };
    }
  }

  append(receipt: unknown): Promise<ReceiptDecision<{ receiptId: string }>> {
    const parsed = outcomeV2Schema.safeParse(receipt);
    if (!parsed.success) return Promise.resolve({ kind: 'refused', code: 'INVALID_INPUT' });
    const r: OutcomeV2 = parsed.data;
    return this.call(r.tenantId, r.requesterRef, 'SELECT public.agentic_explain_receipt_append($1::jsonb) AS result', [JSON.stringify(r)], appended);
  }
  read(tenantId: string, actor: string, runId: string): Promise<ReceiptDecision<OutcomeV2 | null>> {
    return this.call(tenantId, actor, 'SELECT public.agentic_explain_receipt_read($1::text) AS result', [runId], readBack);
  }
}
