import { describe, expect, test } from 'vitest';
import { SyntheticJobQueue } from '../durable/queue';
import { SYNTHETIC_JOB_TYPE } from '../durable/contracts';
import type { Queryable } from '@telesphoros/jobs';

const jobId = '11111111-1111-4111-8111-111111111111';
const runId = '22222222-2222-4222-8222-222222222222';
const claimId = '33333333-3333-4333-8333-333333333333';
const options = { types: [SYNTHETIC_JOB_TYPE], batch: 1, tenantCap: 1, leaseSeconds: 15 };
const claimRow = () => ({ id: jobId, tenant_id: 'synthetic-a', type: SYNTHETIC_JOB_TYPE,
  payload: { runId }, attempt: 1, max_attempts: 1, lease_until: new Date(Date.now() + 15000),
  requested_by: 'fixture-requester', run_id: runId, claim_id: claimId, fence: '1', sequence: '2', state: 'queued' });

function fake(row: Record<string, unknown> = claimRow()) {
  const calls: { sql: string; values: unknown[] | undefined }[] = [];
  const db: Queryable = { async query(sql, values) {
    calls.push({ sql, values });
    if (sql.includes('agentic_synthetic_claim')) return { rows: [row] };
    if (sql.includes('agentic_synthetic_queue_control')) return { rows: [{ result: { kind: 'ok', value: true } }] };
    throw new Error('unexpected SQL');
  } };
  return { db, calls };
}

describe('inactive synthetic queue boundary', () => {
  test('refuses unfixed claim options without touching SQL', async () => {
    const { db, calls } = fake(); const queue = new SyntheticJobQueue(db);
    for (const change of [
      { types: ['other'] }, { batch: 3 }, { batch: 0 }, { tenantCap: 2 }, { leaseSeconds: 60 },
    ]) await expect(queue.claim('worker-a', { ...options, ...change })).rejects.toThrow('INVALID_INPUT');
    expect(calls).toEqual([]);
  });

  test('claims only ID payload, records immutable claim-time stamp and fences controls', async () => {
    const { db, calls } = fake(); const queue = new SyntheticJobQueue(db);
    const [job] = await queue.claim('worker-a', options);
    expect(job?.payload).toEqual({ runId });
    expect(queue.claimFor(jobId, 'worker-a')).toEqual({ stamp: { jobId, runId, workerId: 'worker-a',
      queueAttempt: 1, claimId, fence: '1' }, expected: { sequence: '2', state: 'queued' } });
    expect(Object.isFrozen(queue.claimFor(jobId, 'worker-a')?.stamp)).toBe(true);
    expect(queue.claimFor(jobId, 'worker-b')).toBeNull();
    expect(await queue.heartbeat(jobId, 'worker-b', 15)).toBe(false);
    expect(await queue.heartbeat(jobId, 'worker-a', 60)).toBe(false);
    expect(await queue.succeed(jobId, 'worker-a')).toBe(true);
    expect(calls[0]?.sql).toContain('agentic_synthetic_claim');
    expect(calls[1]?.sql).toContain('agentic_synthetic_queue_control');
    expect(calls.map(c => c.sql).join(' ')).not.toMatch(/\bjob_(claim|heartbeat|succeed|fail|release)\b/);
    expect(JSON.parse(calls[1]?.values?.[0] as string)).toEqual(queue.claimFor(jobId, 'worker-a')?.stamp);
  });

  test('malformed or duplicate claims never expose a new dispatch stamp', async () => {
    for (const changed of [
      { payload: { runId, requesterRef: 'wrong' } }, { payload: { runId: claimId } },
      { max_attempts: 2 }, { claim_id: 'bad' }, { fence: '0' },
    ]) {
      const { db } = fake({ ...claimRow(), ...changed }); const queue = new SyntheticJobQueue(db);
      await expect(queue.claim('worker-a', options)).rejects.toThrow();
      expect(queue.claimFor(jobId, 'worker-a')).toBeNull();
    }
    const { db } = fake(); const queue = new SyntheticJobQueue(db);
    await queue.claim('worker-a', options);
    await expect(queue.claim('worker-a', options)).rejects.toThrow('STALE_CLAIM');
  });

  test('never invokes unrelated scheduling or outbox methods', async () => {
    const { db, calls } = fake(); const queue = new SyntheticJobQueue(db);
    await expect(queue.scheduleTick()).rejects.toThrow('INVALID_INPUT');
    await expect(queue.relayOutbox()).rejects.toThrow('INVALID_INPUT');
    expect(calls).toEqual([]);
  });
});
