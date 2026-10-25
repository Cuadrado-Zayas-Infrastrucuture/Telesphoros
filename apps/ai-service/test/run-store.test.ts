import { createHash } from 'node:crypto';
import type { Queryable } from '@telesphoros/jobs';
import { describe, expect, test } from 'vitest';
import { PostgresExplainStore } from '../durable/run-store';
import type { Run } from '../src/contracts';
import type { ExplainContext } from '../src/explain-contracts';

const ID = '6d2f1d58-5b62-4a5b-9b0a-1f0f0f0f0f0f';
const run = (patch: Partial<Run> = {}): Run => ({
  id: ID,
  tenantId: 'tenant-a',
  requesterRef: 'staff-a',
  state: 'admitted',
  sequence: 0,
  fence: 1,
  admittedAt: 1_000,
  monoAt: 5,
  deadlineAt: 121_000,
  profileDigest: `sha256:${'b'.repeat(64)}`,
  ...patch,
});
const context: ExplainContext = { tenantId: 'tenant-a', requesterRef: 'staff-a', authorityGeneration: 1, purpose: 'pharmacogenomic-explanation' };

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
const store = (answer: (sql: string, args: unknown[]) => unknown) => {
  const b = binder(answer);
  return { store: new PostgresExplainStore(b.app, { tenantId: 'tenant-a', actor: 'staff-a' }), sent: b.sent };
};

describe('the durable run store adapter', () => {
  test('admit hashes the idempotency key, floors the monotonic time, binds the identity and returns the run', async () => {
    const { store: s, sent } = store(() => ({ kind: 'ok', value: { kind: 'new', run: run() } }));
    const key = JSON.stringify(['tenant-a', 'staff-a', 'pgx.explain.v1', 'key-1']);
    const out = await s.admit(key, `hmac-sha256:${'c'.repeat(64)}`, context, `sha256:${'b'.repeat(64)}`, 1_000, 5.9);
    expect(out).toEqual({ kind: 'new', run: run() });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ tenant: 'tenant-a', actor: 'staff-a', sql: 'SELECT public.agentic_explain_run_admit($1::text, $2::text, $3::text, $4::bigint) AS result' });
    expect(sent[0].args).toEqual([`sha256:${createHash('sha256').update(key).digest('hex')}`, `hmac-sha256:${'c'.repeat(64)}`, `sha256:${'b'.repeat(64)}`, 5]);
    expect(JSON.stringify(sent[0].args)).not.toContain('key-1'); // the database never sees the key
  });
  test('admit passes existing and conflict through', async () => {
    for (const kind of ['existing', 'conflict']) {
      const { store: s } = store(() => ({ kind: 'ok', value: { kind, run: run({ state: 'running' }) } }));
      expect((await s.admit('k', `hmac-sha256:${'c'.repeat(64)}`, context, `sha256:${'b'.repeat(64)}`, 0, 0)).kind).toBe(kind);
    }
  });
  test('admit for another identity than the store was built for is refused before the database is called', async () => {
    const { store: s, sent } = store(() => ({ kind: 'ok', value: { kind: 'new', run: run() } }));
    await expect(s.admit('k', `hmac-sha256:${'c'.repeat(64)}`, { ...context, tenantId: 'tenant-b' }, `sha256:${'b'.repeat(64)}`, 0, 0)).rejects.toThrow(
      'RUN_STORE_IDENTITY_MISMATCH',
    );
    await expect(s.admit('k', `hmac-sha256:${'c'.repeat(64)}`, { ...context, requesterRef: 'staff-z' }, `sha256:${'b'.repeat(64)}`, 0, 0)).rejects.toThrow(
      'RUN_STORE_IDENTITY_MISMATCH',
    );
    expect(sent).toEqual([]);
  });
  test.each(['NOT_AUTHORIZED', 'INVALID_INPUT', 'RATE_LIMITED'])('a %s refusal on admit rejects, so the run holds', async (code) => {
    const { store: s } = store(() => ({ kind: 'refused', code }));
    await expect(s.admit('k', `hmac-sha256:${'c'.repeat(64)}`, context, `sha256:${'b'.repeat(64)}`, 0, 0)).rejects.toThrow(`RUN_STORE_${code}`);
  });
  test('get returns the run, and rejects when there is none or the answer is refused', async () => {
    expect(await store(() => ({ kind: 'ok', value: run() })).store.get(ID)).toEqual(run());
    await expect(store(() => ({ kind: 'ok', value: null })).store.get(ID)).rejects.toThrow('RUN_STORE_NO_RUN');
    await expect(store(() => ({ kind: 'refused', code: 'NOT_AUTHORIZED' })).store.get(ID)).rejects.toThrow('RUN_STORE_NOT_AUTHORIZED');
  });
  test('advance sends the expectation the caller saw and returns the next run', async () => {
    const { store: s, sent } = store(() => ({ kind: 'ok', value: run({ state: 'queued', sequence: 1 }) }));
    expect(await s.advance(run(), 'queued')).toEqual(run({ state: 'queued', sequence: 1 }));
    expect(sent[0].sql).toBe('SELECT public.agentic_explain_run_advance($1::uuid, $2::jsonb, $3::text) AS result');
    expect(sent[0].args).toEqual([ID, JSON.stringify({ state: 'admitted', sequence: 0, fence: 1 }), 'queued']);
  });
  test.each(['STALE', 'INVALID_TRANSITION', 'NOT_FOUND'])('advance answers null for %s, as the port says', async (code) =>
    expect(await store(() => ({ kind: 'refused', code })).store.advance(run(), 'queued')).toBeNull(),
  );
  test.each(['NOT_AUTHORIZED', 'INVALID_INPUT'])('advance rejects for %s: that is not a lost race but a fault', async (code) => {
    await expect(store(() => ({ kind: 'refused', code })).store.advance(run(), 'queued')).rejects.toThrow(`RUN_STORE_${code}`);
  });
  test('a transport error and an answer of the wrong shape reject, never pass', async () => {
    const bad = [
      new Error('connection reset'),
      null,
      'ok',
      { kind: 'ok' },
      { kind: 'ok', value: { kind: 'new' } },
      { kind: 'ok', value: { kind: 'new', run: { ...run(), state: 'bogus' } } },
      { kind: 'ok', value: { kind: 'new', run: { ...run(), extra: 1 } } },
      { kind: 'ok', value: { kind: 'new', run: { ...run(), id: 'not-a-uuid' } } },
      { kind: 'ok', value: { kind: 'new', run: { ...run(), sequence: -1 } } },
      { kind: 'ok', value: { kind: 'other', run: run() } },
    ];
    for (const answer of bad) await expect(store(() => answer).store.admit('k', `hmac-sha256:${'c'.repeat(64)}`, context, `sha256:${'b'.repeat(64)}`, 0, 0)).rejects.toThrow();
  });
});
