import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PostgresSyntheticStore, type TenantTransactions } from '../durable/postgres';
import { syntheticTestJob } from '../durable/job';
import { SyntheticJobQueue } from '../durable/queue';
import { scriptedObservationSchema, terminalProposalSchema } from '../durable/contracts';
import type { Queryable } from '@telesphoros/jobs';

const runId = '22222222-2222-4222-8222-222222222222';
const grantId = '44444444-4444-4444-8444-444444444444';
const caller = { tenantId: 'synthetic-a', requesterRef: 'fixture-requester', membershipVersion: '3', grantId, grantGeneration: '1' };
const input = { schemaVersion: 'agentic.request.v1', taskKey: 'business.sop-draft.v1', locale: 'en',
  question: 'Draft a synthetic SOP.', idempotencyKey: 'fixture/one' };

function harness(result: unknown) {
  const calls: { sql: string; values: unknown[] | undefined }[] = [];
  const tenantCalls: { tenant: string; actor: string }[] = [];
  const db: Queryable = { async query(sql, values) { calls.push({ sql, values }); return { rows: [{ result }] }; } };
  const app: TenantTransactions = { async withTenant(tenant, work, options) {
    tenantCalls.push({ tenant, actor: options.actor }); return work(db);
  } };
  return { store: new PostgresSyntheticStore(db, app), calls, tenantCalls };
}

describe('durable adapter is an inert, parameterized boundary', () => {
  test('partial local slice is unreachable from the production package entry', () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const pkg = JSON.parse(readFileSync(`${root}/package.json`, 'utf8')) as { exports: Record<string, unknown> };
    expect(Object.keys(pkg.exports)).toEqual(['.']);
    expect(readFileSync(`${root}/tsup.config.ts`, 'utf8')).toContain("entry: ['src/index.ts']");
    expect(readFileSync(`${root}/src/index.ts`, 'utf8')).not.toContain('durable');
  });

  test('factory creation registers only a test definition and starts no work', () => {
    const { store, calls } = harness({ kind: 'refused', code: 'NOT_AUTHORIZED' });
    const db: Queryable = { async query() { throw new Error('unexpected database access'); } };
    const queue = new SyntheticJobQueue(db);
    const job = syntheticTestJob(queue, store, {
      draft: async () => { throw new Error('unexpected actor'); },
      director: async () => { throw new Error('unexpected actor'); },
    });
    expect(job.definition).toMatchObject({ type: 'test.agentic-synthetic', testOnly: true,
      maxAttempts: 1, leaseSeconds: 15, timeoutSeconds: 120 });
    expect(calls).toEqual([]);
  });

  test('valid app admission binds current tenant and actor, and passes only parameters', async () => {
    const admission = { schemaVersion: 'synthetic.durable.v1', kind: 'new', runId,
      jobId: '11111111-1111-4111-8111-111111111111', state: 'queued', sequence: '1', deadlineAt: '2026-10-18T20:00:00Z' };
    const { store, calls, tenantCalls } = harness({ kind: 'ok', value: admission });
    expect(await store.admit(input, caller)).toEqual({ kind: 'ok', value: admission });
    expect(tenantCalls).toEqual([{ tenant: caller.tenantId, actor: caller.requesterRef }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toBe('SELECT public.agentic_synthetic_admit($1::jsonb,$2::jsonb) AS result');
    expect(calls[0]?.sql).not.toContain(input.question);
    expect(JSON.parse(calls[0]?.values?.[0] as string)).toEqual(input);
  });

  test('read and cancel bind UUID separately from strict caller JSON', async () => {
    const { store, calls } = harness({ kind: 'ok', value: null });
    expect(await store.read(runId, caller)).toEqual({ kind: 'ok', value: null });
    expect(calls[0]?.sql).toContain('agentic_synthetic_read($1::uuid,$2::jsonb)');
    expect(calls[0]?.values?.[0]).toBe(runId);
    await store.cancel(runId, caller);
    expect(calls[1]?.sql).toContain('agentic_synthetic_cancel($1::uuid,$2::jsonb)');
  });

  test('bad input and NUL never reach database', async () => {
    const { store, calls, tenantCalls } = harness({ kind: 'refused', code: 'NOT_AUTHORIZED' });
    expect(await store.admit({ ...input, question: 'bad\u0000text' }, caller)).toEqual({ kind: 'refused', code: 'INVALID_INPUT' });
    expect(await store.admit({ ...input, extra: 'authority' }, caller)).toEqual({ kind: 'refused', code: 'INVALID_INPUT' });
    expect(await store.read('not-a-uuid', caller)).toEqual({ kind: 'refused', code: 'INVALID_INPUT' });
    expect(await store.read(runId, { ...caller, grantGeneration: '0' })).toEqual({ kind: 'refused', code: 'INVALID_INPUT' });
    expect(calls).toEqual([]); expect(tenantCalls).toEqual([]);
  });

  test('actor receipts and simulated release proposals enforce their closed bounds', () => {
    const base = { invocationId: grantId, role: 'draft', inputDigest: 'sha256:' + 'a'.repeat(64),
      observation: { inputUnits: 4096, generatedUnits: 768 }, artifact: null };
    expect(scriptedObservationSchema.safeParse(base).success).toBe(true);
    expect(scriptedObservationSchema.safeParse({ ...base, observation: { inputUnits: 4097, generatedUnits: 0 } }).success).toBe(false);
    expect(scriptedObservationSchema.safeParse({ ...base, observation: null, artifact: { text: 'forged' } }).success).toBe(false);
    expect(terminalProposalSchema.safeParse({ terminalState: 'released', reasonCode: 'SIMULATED_RELEASE' }).success).toBe(false);
    expect(terminalProposalSchema.safeParse({ terminalState: 'held', reasonCode: 'DIRECTOR_HELD', evidenceDigest: base.inputDigest }).success).toBe(false);
  });

  test('bad DB envelope and transport error fail closed without returning SQL text', async () => {
    const malformed = harness({ kind: 'ok', value: { raw: 'fixture body' } });
    expect(await malformed.store.read(runId, caller)).toEqual({ kind: 'refused', code: 'STORAGE_UNAVAILABLE' });
    const failingDb: Queryable = { async query() { throw new Error('sensitive SQL diagnostic'); } };
    const app: TenantTransactions = { withTenant: async (_tenant, work) => work(failingDb) };
    const store = new PostgresSyntheticStore(failingDb, app);
    expect(await store.read(runId, caller)).toEqual({ kind: 'refused', code: 'STORAGE_UNAVAILABLE' });
  });
});
