import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { JobQueue, retryDelaySeconds } from '@telesphoros/jobs';
import { PERSON, TENANT_A, TENANT_B, TENANT_SUSPENDED, attemptsOf, createFixture, enqueueAs, jobRow, type Fixture } from './support';

let f: Fixture;
let queue: JobQueue;
beforeAll(async () => {
  f = await createFixture();
  queue = new JobQueue(f.worker);
});
afterAll(async () => f.close());

let counter = 0;
const key = () => `k-${++counter}`;
const claim = (worker: string, types = ['test.echo'], batch = 10, tenantCap = 50, leaseSeconds = 30) => queue.claim(worker, { types, batch, tenantCap, leaseSeconds });
const reset = () => f.admin.query(`UPDATE jobs SET state = 'cancelled', lease_until = NULL, locked_by = NULL, finished_at = now() WHERE state IN ('queued', 'retry', 'running')`);

describe('enqueue (the application login)', () => {
  it('takes the organization and the person from the transaction, never from arguments', async () => {
    const { jobId, created } = await enqueueAs(f.db, TENANT_A, PERSON, 'test.echo', { n: 1 }, key());
    expect(created).toBe(true);
    const row = await jobRow(f.admin, jobId);
    expect(row).toMatchObject({ tenant_id: TENANT_A, requested_by: PERSON, state: 'queued', attempts: 0, max_attempts: 3 });
  });

  it('refuses an enqueue with no organization or no person bound', async () => {
    await expect(enqueueAs(f.db, undefined, PERSON, 'test.echo', { n: 1 }, key())).rejects.toThrow(/organization and a person/);
    await expect(enqueueAs(f.db, TENANT_A, undefined, 'test.echo', { n: 1 }, key())).rejects.toThrow(/organization and a person/);
  });

  it('returns the existing job for the same key and enqueues a separate job per organization', async () => {
    const k = key();
    const first = await enqueueAs(f.db, TENANT_A, PERSON, 'test.echo', { n: 1 }, k);
    const again = await enqueueAs(f.db, TENANT_A, PERSON, 'test.echo', { n: 99 }, k);
    expect(again).toEqual({ jobId: first.jobId, created: false });
    expect((await jobRow(f.admin, first.jobId)).payload).toEqual({ n: 1 });
    const other = await enqueueAs(f.db, TENANT_B, PERSON, 'test.echo', { n: 1 }, k);
    expect(other.jobId).not.toBe(first.jobId);
    expect(other.created).toBe(true);
  });

  it('refuses, in the database, a payload that could carry text, nesting or a value that is not an id', async () => {
    const bad: unknown[] = [
      { name: 'Jane Doe' }, // space
      { note: 'x'.repeat(65) },
      { nested: { a: 1 } },
      { list: [1] },
      { gone: null },
      { Upper: 1 },
      { 'has-dash': 1 },
      { k1234567890123456789012345678901234: 1 },
      [],
      'text',
      { a: 'é' },
      Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`k${i}`, 'aaaaaaaaaaaaaaaaaaaa'])),
    ];
    for (const payload of bad) {
      const label = JSON.stringify(payload).slice(0, 60);
      await expect(enqueueAs(f.db, TENANT_A, PERSON, 'test.echo', payload, key()).then(() => `accepted ${label}`, (e: Error) => e.message)).resolves.toMatch(/jobs_payload_shape/);
    }
  });

  it('refuses a malformed type or key', async () => {
    await expect(enqueueAs(f.db, TENANT_A, PERSON, 'Bad Type', {}, key())).rejects.toThrow(/jobs_type_shape/);
    await expect(enqueueAs(f.db, TENANT_A, PERSON, 'test.echo', {}, 'has space')).rejects.toThrow(/jobs_key_shape/);
    await expect(enqueueAs(f.db, TENANT_A, PERSON, 'test.echo', {}, 'x'.repeat(97))).rejects.toThrow(/jobs_key_shape/);
  });

  it('cannot enqueue for an organization that does not exist', async () => {
    await expect(enqueueAs(f.db, 'no-such-organization', PERSON, 'test.echo', {}, key())).rejects.toThrow(/foreign key|jobs_tenant_id_fkey/);
  });
});

describe('claim', () => {
  it('hands each ready job to exactly one claimer, oldest first, and not before run_after', async () => {
    await reset();
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) ids.push((await enqueueAs(f.db, TENANT_A, PERSON, 'test.echo', { n: i }, key())).jobId);
    await enqueueAs(f.db, TENANT_A, PERSON, 'test.echo', { n: 9 }, key(), { runAfter: new Date(Date.now() + 3_600_000) });
    await enqueueAs(f.db, TENANT_A, PERSON, 'test.slow', { ms: 1 }, key());
    const got = await claim('w1');
    expect(got.map((j) => j.id)).toEqual(ids);
    expect(got[0]).toMatchObject({ attempt: 1, maxAttempts: 3, tenantId: TENANT_A, requestedBy: PERSON, type: 'test.echo' });
    expect(await claim('w2')).toEqual([]);
    const row = await jobRow(f.admin, ids[0]!);
    expect(row).toMatchObject({ state: 'running', locked_by: 'w1', attempts: 1 });
  });

  it('never gives one job to two concurrent claimers', async () => {
    await reset();
    const total = 60;
    for (let i = 0; i < total; i += 1) await enqueueAs(f.db, i % 2 ? TENANT_A : TENANT_B, PERSON, 'test.echo', { n: i }, key());
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => claim(`racer-${i}`, ['test.echo'], 7)));
    // A claimer that finds an organization busy with another claimer leaves it for the next round, so drain until a round finds nothing.
    const all = results.flat().map((j) => j.id);
    for (let round = 0; round < 20; round += 1) {
      const more = (await Promise.all(Array.from({ length: 4 }, (_, i) => claim(`racer-late-${round}-${i}`, ['test.echo'], 20)))).flat();
      if (more.length === 0) break;
      all.push(...more.map((j) => j.id));
    }
    expect(all).toHaveLength(total);
    expect(new Set(all).size).toBe(total);
  });

  it('passes over a job another session holds locked instead of waiting for it', async () => {
    await reset();
    const first = (await enqueueAs(f.db, TENANT_A, PERSON, 'test.echo', { n: 1 }, key())).jobId;
    const second = (await enqueueAs(f.db, TENANT_A, PERSON, 'test.echo', { n: 2 }, key())).jobId;
    const holder = await f.admin.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT id FROM jobs WHERE id = $1 FOR UPDATE', [first]);
      const outcome = await Promise.race([claim('skipper', ['test.echo'], 1), new Promise<'waited'>((r) => setTimeout(() => r('waited'), 3000))]);
      expect(outcome).not.toBe('waited');
      expect((outcome as Awaited<ReturnType<typeof claim>>).map((j) => j.id)).toEqual([second]);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
  });

  it('holds an organization to its cap of running jobs, across claimers', async () => {
    await reset();
    for (let i = 0; i < 8; i += 1) await enqueueAs(f.db, TENANT_A, PERSON, 'test.echo', { n: i }, key());
    for (let i = 0; i < 3; i += 1) await enqueueAs(f.db, TENANT_B, PERSON, 'test.echo', { n: i }, key());
    const batches = await Promise.all(Array.from({ length: 6 }, (_, i) => claim(`cap-${i}`, ['test.echo'], 10, 2)));
    const got = batches.flat();
    expect(got.filter((j) => j.tenantId === TENANT_A)).toHaveLength(2);
    expect(got.filter((j) => j.tenantId === TENANT_B)).toHaveLength(2);
    // A finished job frees a place.
    const first = got.find((j) => j.tenantId === TENANT_A)!;
    expect(await queue.succeed(first.id, (await jobRow(f.admin, first.id)).locked_by as string)).toBe(true);
    expect((await claim('cap-next', ['test.echo'], 10, 2)).filter((j) => j.tenantId === TENANT_A)).toHaveLength(1);
  });

  it('does not let an organization at its cap hide everyone else behind its backlog', async () => {
    await reset();
    await f.admin.query(`INSERT INTO jobs (tenant_id, type, payload, idempotency_key, requested_by, run_after) SELECT $1, 'test.echo', '{}', 'bulk-' || g, $2, now() - interval '1 hour' FROM generate_series(1, 250) g`, [TENANT_A, PERSON]);
    const { jobId } = await enqueueAs(f.db, TENANT_B, PERSON, 'test.echo', { n: 1 }, key());
    const first = await claim('cap-a', ['test.echo'], 10, 2);
    expect(first.filter((j) => j.tenantId === TENANT_A)).toHaveLength(2);
    expect(first.map((j) => j.id)).toContain(jobId);
    await reset();
    await f.admin.query(`DELETE FROM jobs WHERE idempotency_key LIKE 'bulk-%' AND state = 'cancelled'`).catch(() => undefined);
  });

  it('does not claim for a suspended organization, and does once it is active again', async () => {
    await reset();
    const { jobId } = await enqueueAs(f.db, TENANT_SUSPENDED, PERSON, 'test.echo', { n: 1 }, key()).catch(async () => {
      // An organization that is suspended cannot be written for by the application, so the job is placed as the owner.
      const inserted = await f.admin.query(`INSERT INTO jobs (tenant_id, type, payload, idempotency_key, requested_by) VALUES ($1, 'test.echo', '{"n":1}', $2, $3) RETURNING id`, [TENANT_SUSPENDED, key(), PERSON]);
      return { jobId: inserted.rows[0].id as string };
    });
    expect(await claim('susp')).toEqual([]);
    expect((await jobRow(f.admin, jobId)).state).toBe('queued');
    await f.admin.query(`UPDATE tenants SET status = 'active' WHERE id = $1`, [TENANT_SUSPENDED]);
    try {
      expect((await claim('susp')).map((j) => j.id)).toEqual([jobId]);
    } finally {
      await f.admin.query(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [TENANT_SUSPENDED]);
      await reset();
    }
  });

  it('refuses limits out of range', async () => {
    await expect(claim('w', ['test.echo'], 0)).rejects.toThrow(/limits/);
    await expect(claim('w', ['test.echo'], 51)).rejects.toThrow(/limits/);
    await expect(claim('w', ['test.echo'], 1, 0)).rejects.toThrow(/limits/);
    await expect(claim('w', ['test.echo'], 1, 1, 4)).rejects.toThrow(/limits/);
  });
});

describe('leases', () => {
  it('lets only the holder heartbeat, succeed, fail or release a job', async () => {
    await reset();
    const { jobId } = await enqueueAs(f.db, TENANT_A, PERSON, 'test.echo', { n: 1 }, key());
    const [job] = await claim('holder');
    expect(job!.id).toBe(jobId);
    expect(await queue.heartbeat(jobId, 'intruder', 30)).toBe(false);
    expect(await queue.succeed(jobId, 'intruder')).toBe(false);
    expect(await queue.fail(jobId, 'intruder', 'nope', true)).toBeUndefined();
    expect(await queue.release(jobId, 'intruder')).toBe(false);
    expect(await queue.heartbeat(jobId, 'holder', 600)).toBe(true);
    const lease = (await jobRow(f.admin, jobId)).lease_until as Date;
    expect(lease.getTime()).toBeGreaterThan(Date.now() + 500_000);
    expect(await queue.succeed(jobId, 'holder')).toBe(true);
    expect(await queue.succeed(jobId, 'holder')).toBe(false); // twice is harmless
    expect((await attemptsOf(f.admin, jobId)).map((a) => a.outcome)).toEqual(['succeeded']);
  });

  it('gives a job back after its lease runs out, records it, and stops a late heartbeat from the old holder', async () => {
    await reset();
    const { jobId } = await enqueueAs(f.db, TENANT_A, PERSON, 'test.echo', { n: 1 }, key());
    await claim('crashed');
    await f.admin.query(`UPDATE jobs SET lease_until = now() - interval '1 second' WHERE id = $1`, [jobId]);
    expect(await queue.heartbeat(jobId, 'crashed', 30)).toBe(false);
    const [again] = await claim('rescuer');
    expect(again).toMatchObject({ id: jobId, attempt: 2 });
    expect(await queue.succeed(jobId, 'crashed')).toBe(false);
    expect(await queue.succeed(jobId, 'rescuer')).toBe(true);
    expect(await attemptsOf(f.admin, jobId)).toEqual([
      { attempt: 1, outcome: 'lease-expired', error_code: 'lease-expired', worker_id: 'crashed' },
      { attempt: 2, outcome: 'succeeded', error_code: null, worker_id: 'rescuer' },
    ]);
  });

  it('kills a job whose lease keeps running out once its attempts are used', async () => {
    await reset();
    const { jobId } = await enqueueAs(f.db, TENANT_A, PERSON, 'test.echo', { n: 1 }, key(), { maxAttempts: 2 });
    for (let i = 0; i < 2; i += 1) {
      expect(await claim(`w${i}`)).toHaveLength(1);
      await f.admin.query(`UPDATE jobs SET lease_until = now() - interval '1 second' WHERE id = $1`, [jobId]);
    }
    expect(await claim('w3')).toEqual([]);
    expect(await jobRow(f.admin, jobId)).toMatchObject({ state: 'dead', last_error_code: 'lease-expired', attempts: 2, locked_by: null });
    expect(await claim('w4')).toEqual([]);
    expect((await attemptsOf(f.admin, jobId)).map((a) => a.outcome)).toEqual(['lease-expired', 'lease-expired']);
  });
});

describe('failure, backoff and dead letters', () => {
  it('retries a retryable failure after 1 min, 5 min, 25 min (+-20%), then dead at the attempt cap', async () => {
    await reset();
    const { jobId } = await enqueueAs(f.db, TENANT_A, PERSON, 'test.echo', { n: 1 }, key(), { maxAttempts: 4 });
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const [job] = await claim('w');
      expect(job).toMatchObject({ id: jobId, attempt });
      expect(await queue.fail(jobId, 'w', 'upstream-timeout', true)).toBe('retry');
      const row = await jobRow(f.admin, jobId);
      const delay = ((row.run_after as Date).getTime() - Date.now()) / 1000;
      const nominal = retryDelaySeconds(attempt, 0.5);
      expect(delay).toBeGreaterThan(nominal * 0.8 - 5);
      expect(delay).toBeLessThanOrEqual(nominal * 1.2 + 1);
      expect(row).toMatchObject({ state: 'retry', last_error_code: 'upstream-timeout', lease_until: null, locked_by: null });
      expect(await claim('w')).toEqual([]); // not before its time
      await f.admin.query(`UPDATE jobs SET run_after = now() WHERE id = $1`, [jobId]);
    }
    await claim('w');
    expect(await queue.fail(jobId, 'w', 'upstream-timeout', true)).toBe('dead');
    expect(await jobRow(f.admin, jobId)).toMatchObject({ state: 'dead', attempts: 4, finished_at: expect.any(Date) });
    expect(await claim('w')).toEqual([]);
    expect((await attemptsOf(f.admin, jobId)).map((a) => a.outcome)).toEqual(['failed', 'failed', 'failed', 'failed']);
  });

  it('agrees with the TypeScript delay for every attempt and caps at an hour', async () => {
    await reset();
    for (const attempt of [1, 2, 3, 4, 5, 6]) {
      const { jobId } = await enqueueAs(f.db, TENANT_A, PERSON, 'test.echo', { n: attempt }, key(), { maxAttempts: 20 });
      await f.admin.query(`UPDATE jobs SET state = 'running', attempts = $2, locked_by = 'w', lease_until = now() + interval '1 minute', started_at = now() WHERE id = $1`, [jobId, attempt]);
      await queue.fail(jobId, 'w', 'upstream-timeout', true);
      const seconds = (((await jobRow(f.admin, jobId)).run_after as Date).getTime() - Date.now()) / 1000;
      expect(seconds).toBeGreaterThanOrEqual(retryDelaySeconds(attempt, 0) - 2);
      expect(seconds).toBeLessThanOrEqual(retryDelaySeconds(attempt, 1) + 1);
      expect(seconds).toBeLessThanOrEqual(3600 * 1.2 + 1);
    }
  });

  it('makes a fatal failure dead at once, and refuses an error code that could carry text', async () => {
    await reset();
    const { jobId } = await enqueueAs(f.db, TENANT_A, PERSON, 'test.echo', { n: 1 }, key());
    await claim('w');
    for (const code of ['Has Space', 'patient Jane Doe', 'x', '', 'a'.repeat(49), 'dotted.code']) await expect(queue.fail(jobId, 'w', code, true)).rejects.toThrow(/short code/);
    expect(await queue.fail(jobId, 'w', 'bad-input', false)).toBe('dead');
    expect(await attemptsOf(f.admin, jobId)).toEqual([{ attempt: 1, outcome: 'failed', error_code: 'bad-input', worker_id: 'w' }]);
  });

  it('gives a released job back without counting the attempt it never made', async () => {
    await reset();
    const { jobId } = await enqueueAs(f.db, TENANT_A, PERSON, 'test.echo', { n: 1 }, key());
    await claim('w');
    expect(await queue.release(jobId, 'w')).toBe(true);
    expect(await jobRow(f.admin, jobId)).toMatchObject({ state: 'queued', attempts: 0, locked_by: null, lease_until: null });
    expect((await attemptsOf(f.admin, jobId)).map((a) => a.outcome)).toEqual(['released']);
    expect((await claim('w'))[0]).toMatchObject({ id: jobId, attempt: 1 });
  });
});

describe('the schedule', () => {
  it('enqueues one job per active organization per slot, once however many ticks', async () => {
    await reset();
    await f.admin.query(`INSERT INTO job_schedules (type, interval_seconds) VALUES ('test.echo', 3600)`);
    try {
      const at = new Date('2030-01-01T10:20:00Z');
      const first = await queue.scheduleTick(at);
      expect(first).toBe(2); // TENANT_A and TENANT_B; the suspended organization gets none
      expect(await queue.scheduleTick(at)).toBe(0);
      expect(await Promise.all([queue.scheduleTick(at), queue.scheduleTick(at), queue.scheduleTick(new Date('2030-01-01T10:59:59Z'))])).toEqual([0, 0, 0]);
      expect(await queue.scheduleTick(new Date('2030-01-01T11:00:01Z'))).toBe(2);
      const rows = (await f.admin.query(`SELECT tenant_id, requested_by, idempotency_key FROM jobs WHERE type = 'test.echo' AND idempotency_key LIKE 'slot-%' ORDER BY idempotency_key, tenant_id`)).rows;
      expect(rows).toHaveLength(4);
      expect(new Set(rows.map((r) => r.requested_by))).toEqual(new Set(['system:scheduler']));
      expect(rows.map((r) => r.tenant_id)).not.toContain(TENANT_SUSPENDED);
    } finally {
      await f.admin.query(`DELETE FROM job_schedules`);
    }
  });
});

describe('what the worker login can and cannot do', () => {
  it('can call the queue functions and read the job tables, and nothing else', async () => {
    const w = new Client({ connectionString: f.db.workerUrl });
    await w.connect();
    try {
      const refused = async (sql: string) => expect(w.query(sql)).rejects.toThrow(/permission denied|must be owner|row-level security/);
      await refused(`INSERT INTO jobs (tenant_id, type, idempotency_key, requested_by) VALUES ('${TENANT_A}', 'test.echo', 'sneaky', 'x')`);
      await refused(`UPDATE jobs SET state = 'succeeded'`);
      await refused(`DELETE FROM jobs`);
      await refused(`INSERT INTO job_attempts (job_id, tenant_id, attempt, worker_id, outcome) SELECT id, tenant_id, 1, 'x', 'succeeded' FROM jobs LIMIT 1`);
      await refused(`INSERT INTO job_schedules (type, interval_seconds) VALUES ('test.sneaky', 60)`);
      await refused(`UPDATE tenants SET status = 'active'`);
      await refused(`SELECT * FROM tenants`);
      await refused(`SELECT * FROM tenant_memberships`);
      await refused(`SELECT * FROM patients`);
      await refused(`SELECT * FROM ledger_events`);
      await refused(`SELECT * FROM security_events`);
      await refused(`SELECT * FROM report_upload_attempts`);
      await refused(`SELECT job_enqueue('test.echo', '{}', 'x', now(), 3)`);
      await refused(`SET ROLE telesphoros_jobs`);
      await refused(`SET ROLE telesphoros_app`);
      // Row-level security: with no organization bound, the job tables show nothing; with one bound, only that organization's rows.
      await enqueueAs(f.db, TENANT_A, PERSON, 'test.echo', { n: 1 }, key());
      await enqueueAs(f.db, TENANT_B, PERSON, 'test.echo', { n: 1 }, key());
      expect((await w.query('SELECT count(*)::int AS n FROM jobs')).rows[0].n).toBe(0);
      await w.query('BEGIN');
      await w.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [TENANT_A]);
      const seen = (await w.query('SELECT DISTINCT tenant_id FROM jobs')).rows.map((r) => r.tenant_id);
      await w.query('COMMIT');
      expect(seen).toEqual([TENANT_A]);
    } finally {
      await w.end();
    }
  });

  it('keeps the application login from claiming, settling or editing jobs, and from seeing other organizations', async () => {
    const a = new Client({ connectionString: f.db.appUrl });
    await a.connect();
    try {
      for (const sql of [`SELECT * FROM job_claim('x', ARRAY['test.echo'], 1, 1, 30)`, `SELECT job_succeed(gen_random_uuid(), 'x')`, `SELECT job_schedule_tick()`, `UPDATE jobs SET state = 'dead'`, `DELETE FROM jobs`, `INSERT INTO jobs (tenant_id, type, idempotency_key, requested_by) VALUES ('${TENANT_A}', 'test.echo', 'sneaky', 'x')`]) {
        await expect(a.query(sql)).rejects.toThrow(/permission denied/);
      }
      await a.query('BEGIN');
      await a.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [TENANT_B]);
      const seen = (await a.query('SELECT DISTINCT tenant_id FROM jobs')).rows.map((r) => r.tenant_id);
      await a.query('COMMIT');
      expect(seen).toEqual([TENANT_B]);
    } finally {
      await a.end();
    }
  });

  it('keeps the attempt history append-only even for the owner', async () => {
    const id = (await f.admin.query('SELECT id FROM job_attempts LIMIT 1')).rows[0].id as string;
    await expect(f.admin.query('UPDATE job_attempts SET outcome = $2 WHERE id = $1', [id, 'failed'])).rejects.toThrow(/append-only|not allowed|refuse/i);
    await expect(f.admin.query('DELETE FROM job_attempts WHERE id = $1', [id])).rejects.toThrow(/append-only|not allowed|refuse/i);
    await expect(f.admin.query('TRUNCATE job_attempts')).rejects.toThrow(/append-only|not allowed|refuse/i);
  });
});

describe('statistics and liveness', () => {
  it('reports counts and ages by type and state, and records that a worker was seen', async () => {
    await reset();
    await enqueueAs(f.db, TENANT_A, PERSON, 'test.echo', { n: 1 }, key(), { runAfter: new Date(Date.now() - 120_000) });
    const stats = await queue.stats();
    const queued = stats.find((s) => s.type === 'test.echo' && s.state === 'queued')!;
    expect(queued.count).toBe(1);
    expect(queued.oldestReadySeconds).toBeGreaterThan(100);
    await queue.workerSeen('stats-worker');
    await queue.workerSeen('stats-worker');
    expect((await f.admin.query(`SELECT count(*)::int AS n FROM job_workers WHERE worker_id = 'stats-worker'`)).rows[0].n).toBe(1);
  });
});
