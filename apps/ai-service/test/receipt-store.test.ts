import type { Queryable } from '@telesphoros/jobs';
import { describe, expect, test } from 'vitest';
import { PostgresReceiptStore } from '../durable/receipt-store';
import { explainScenario } from './helpers/explain-adapters';
import { runExplanation } from '../src/explain';

/** A binder that records what the adapter sent and answers with whatever the test says the database returned. */
function binder(answer: (sql: string, args: unknown[]) => unknown) {
  const sent: Array<{ tenant: string; actor: string; sql: string; args: unknown[] }> = [];
  const app = {
    async withTenant<T>(tenant: string, work: (db: Queryable) => Promise<T>, options: { actor: string }): Promise<T> {
      return work({
        async query(sql: string, args: unknown[] = []) {
          sent.push({ tenant, actor: options.actor, sql, args });
          const result = answer(sql, args);
          if (result instanceof Error) throw result;
          return { rows: [{ result }], rowCount: 1 } as never;
        },
      } as Queryable);
    },
  };
  return { app, sent };
}
const okAppend = { kind: 'ok', value: { receiptId: '6d2f1d58-5b62-4a5b-9b0a-1f0f0f0f0f0f' } };
const receipt = async () => (await runExplanation(explainScenario().request, explainScenario().context, explainScenario().ports)).receipt!;

describe('the receipt store adapter', () => {
  test("appends a valid receipt as one parameterized call, bound to the receipt's own organization and requester", async () => {
    const { app, sent } = binder(() => okAppend);
    const r = await receipt();
    expect(await new PostgresReceiptStore(app).append(r)).toEqual(okAppend);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ tenant: r.tenantId, actor: r.requesterRef, sql: 'SELECT public.agentic_explain_receipt_append($1::jsonb) AS result' });
    expect(sent[0].args).toEqual([JSON.stringify(r)]);
    expect(sent[0].sql).not.toContain(r.runId);
  });
  test('refuses a receipt with text in it before the database is called', async () => {
    const { app, sent } = binder(() => okAppend);
    const store = new PostgresReceiptStore(app);
    const r = await receipt();
    for (const bad of [
      { ...r, explanation: 'Reduced enzyme function increases exposure.' },
      { ...r, digests: { ...r.digests, evidence: `sha256:${'a'.repeat(64)}` } },
      null,
      'text',
      {},
    ]) {
      expect(await store.append(bad)).toEqual({ kind: 'refused', code: 'INVALID_INPUT' });
    }
    expect(sent).toEqual([]);
  });
  test('maps the database refusals through unchanged, and refuses a refusal code it does not know', async () => {
    for (const code of ['DUPLICATE', 'NOT_AUTHORIZED', 'INVALID_INPUT']) {
      const { app } = binder(() => ({ kind: 'refused', code }));
      expect(await new PostgresReceiptStore(app).append(await receipt())).toEqual({ kind: 'refused', code });
    }
    const { app } = binder(() => ({ kind: 'refused', code: 'SOMETHING_ELSE' }));
    expect(await new PostgresReceiptStore(app).append(await receipt())).toEqual({ kind: 'refused', code: 'STORAGE_UNAVAILABLE' });
  });
  test('a transport error or a malformed answer is STORAGE_UNAVAILABLE, never an ok', async () => {
    for (const answer of [
      new Error('connection reset'),
      null,
      'ok',
      { kind: 'ok' },
      { kind: 'ok', value: { receiptId: 'not-a-uuid' } },
      { kind: 'ok', value: { receiptId: okAppend.value.receiptId, extra: 1 } },
    ]) {
      const { app } = binder(() => answer);
      expect(await new PostgresReceiptStore(app).append(await receipt())).toEqual({ kind: 'refused', code: 'STORAGE_UNAVAILABLE' });
    }
  });
  test('reads a receipt back through outcome v2, so a row with an extra key is not returned', async () => {
    const r = await receipt();
    const good = binder(() => ({ kind: 'ok', value: r }));
    expect(await new PostgresReceiptStore(good.app).read(r.tenantId, r.requesterRef, r.runId)).toEqual({ kind: 'ok', value: r });
    expect(good.sent[0]).toMatchObject({ sql: 'SELECT public.agentic_explain_receipt_read($1::text) AS result', args: [r.runId] });
    const none = binder(() => ({ kind: 'ok', value: null }));
    expect(await new PostgresReceiptStore(none.app).read(r.tenantId, r.requesterRef, 'run-none')).toEqual({ kind: 'ok', value: null });
    const extra = binder(() => ({ kind: 'ok', value: { ...r, explanation: 'text' } }));
    expect(await new PostgresReceiptStore(extra.app).read(r.tenantId, r.requesterRef, r.runId)).toEqual({ kind: 'refused', code: 'STORAGE_UNAVAILABLE' });
  });
  test('purge is one call with no argument, and returns the count', async () => {
    const { app, sent } = binder(() => ({ kind: 'ok', value: { deleted: 3 } }));
    expect(await new PostgresReceiptStore(app).purge('tenant-a', 'staff-a')).toEqual({ kind: 'ok', value: { deleted: 3 } });
    expect(sent[0]).toMatchObject({ tenant: 'tenant-a', actor: 'staff-a', sql: 'SELECT public.agentic_explain_receipt_purge() AS result', args: [] });
  });
});
