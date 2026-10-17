import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PERSON, TENANT_A, TENANT_B, attemptsOf, createFixture, effectDir, enqueueAs, jobRow, startWorker, until, type Fixture, type WorkerProcess } from './support';

let f: Fixture;
let effects: Awaited<ReturnType<typeof effectDir>>;
let started: WorkerProcess[] = [];

beforeAll(async () => {
  f = await createFixture();
});
afterAll(async () => f.close());
afterEach(async () => {
  for (const w of started) {
    w.child.kill('SIGKILL');
    await w.exited;
  }
  started = [];
  await effects?.remove();
});

const begin = async () => {
  effects = await effectDir();
  await f.admin.query(`UPDATE jobs SET state = 'cancelled', lease_until = NULL, locked_by = NULL, finished_at = now() WHERE state IN ('queued', 'retry', 'running')`);
};
const worker = (env: Record<string, string> = {}) => {
  const w = startWorker(f.db, { WORKER_TEST_EFFECT_DIR: effects.dir, ...env });
  started.push(w);
  return w;
};
let n = 0;
const enqueue = (type: string, payload: unknown, tenant = TENANT_A) => enqueueAs(f.db, tenant, PERSON, type, payload, `p-${++n}`).then((r) => r.jobId);
const stateOf = (id: string) => jobRow(f.admin, id).then((r) => r.state as string);
const ready = (w: WorkerProcess) => until('the worker to start', async () => w.output().includes('worker-started'));
const requestShutdown = async (w: WorkerProcess) => {
  expect(w.child.kill('SIGTERM')).toBe(true);
  // Sending a signal does not mean the child's application callback has run.
  await until('the child to acknowledge SIGTERM', async () => w.output().includes('"event":"shutdown-requested","reason":"SIGTERM"'));
};
const expectStoppedReadiness = async (get: () => Promise<{ status: number; body: string }>) => {
  let response;
  try {
    response = await get();
  } catch (error) {
    if (error instanceof TypeError && error.message === 'fetch failed') {
      const code = (error.cause as { code?: string } | undefined)?.code;
      if (['ECONNREFUSED', 'ECONNRESET', 'UND_ERR_SOCKET'].includes(code ?? '')) return;
    }
    throw error;
  }
  expect(response.status).toBe(503);
  expect(JSON.parse(response.body)).toEqual({ status: 'unavailable', running: expect.any(Number), stopping: true });
};

describe('several worker processes', () => {
  it('run every job exactly once to completion, with no job run twice', async () => {
    await begin();
    const workers = ['proc-1', 'proc-2', 'proc-3'].map((id) => worker({ WORKER_ID: id, WORKER_CONCURRENCY: '2', WORKER_TENANT_CAP: '10' }));
    await Promise.all(workers.map(ready));
    // Jobs that take a moment, enqueued once every process is polling, so the work cannot all be done by whichever process started first.
    const ids: string[] = [];
    for (let i = 0; i < 45; i += 1) ids.push(await enqueue('test.slow', { ms: 150 }, i % 3 === 0 ? TENANT_B : TENANT_A));
    await until('all jobs to succeed', async () => (await f.admin.query(`SELECT count(*)::int AS n FROM jobs WHERE id = ANY($1) AND state = 'succeeded'`, [ids])).rows[0].n === ids.length, 30_000);
    const files = await effects.files();
    for (const id of ids) {
      expect(files.filter((x) => x.startsWith(`${id}.run-`)), id).toHaveLength(1);
      expect(files).toContain(`${id}.done`);
      expect((await attemptsOf(f.admin, id)).map((a) => a.outcome)).toEqual(['succeeded']);
    }
    // The work was shared, not done by one process.
    const by = (await f.admin.query(`SELECT worker_id, count(*)::int AS n FROM job_attempts WHERE job_id = ANY($1) GROUP BY worker_id`, [ids])).rows;
    expect(by.length).toBeGreaterThan(1);
  });
});

describe('a worker that dies', () => {
  it('loses its lease and the job completes elsewhere with exactly one durable effect', async () => {
    await begin();
    const id = await enqueue('test.slow', { ms: 4_000 });
    const doomed = worker({ WORKER_ID: 'doomed' });
    await until('the job to start on the doomed worker', async () => (await effects.files()).includes(`${id}.started`));
    doomed.child.kill('SIGKILL');
    await doomed.exited;
    expect(await jobRow(f.admin, id)).toMatchObject({ state: 'running', locked_by: 'doomed' });
    // Nothing else holds a worker: wait for the lease (5 seconds) to run out for real, then start a second worker.
    const rescuer = worker({ WORKER_ID: 'rescuer' });
    await ready(rescuer);
    await until('the job to finish on the rescuer', async () => (await stateOf(id)) === 'succeeded', 30_000);
    expect((await effects.files()).filter((x) => x === `${id}.done`)).toHaveLength(1);
    expect((await effects.files()).filter((x) => x.startsWith(`${id}.run-`)).length).toBe(2); // it ran twice: at-least-once, one effect
    expect(await attemptsOf(f.admin, id)).toEqual([
      { attempt: 1, outcome: 'lease-expired', error_code: 'lease-expired', worker_id: 'doomed' },
      { attempt: 2, outcome: 'succeeded', error_code: null, worker_id: 'rescuer' },
    ]);
  }, 60_000);
});

describe('stopping', () => {
  it('drains on SIGTERM: finishes the running job, claims nothing more, exits cleanly', async () => {
    await begin();
    const id = await enqueue('test.slow', { ms: 1_200 });
    const w = worker({ WORKER_ID: 'drainer', WORKER_DRAIN_SECONDS: '20' });
    await until('the job to start', async () => (await effects.files()).includes(`${id}.started`));
    const later = await enqueue('test.echo', { n: 1 });
    w.child.kill('SIGTERM');
    const exit = await w.exited;
    expect(exit).toEqual({ code: 0, signal: null });
    expect(await stateOf(id)).toBe('succeeded');
    expect(w.output()).toContain('worker-draining');
    expect(await stateOf(later)).toBe('queued');
  });

  it('releases a job it cannot finish within the drain, and a second worker takes it as a first attempt', async () => {
    await begin();
    const id = await enqueue('test.slow', { ms: 60_000 });
    const w = worker({ WORKER_ID: 'impatient', WORKER_DRAIN_SECONDS: '0' });
    await until('the job to start', async () => (await effects.files()).includes(`${id}.started`));
    w.child.kill('SIGTERM');
    expect(await w.exited).toEqual({ code: 0, signal: null });
    expect(await jobRow(f.admin, id)).toMatchObject({ state: 'queued', attempts: 0 });
    const next = worker({ WORKER_ID: 'next' });
    await ready(next);
    await until('the second worker to claim it', async () => (await jobRow(f.admin, id)).locked_by === 'next');
    expect(await jobRow(f.admin, id)).toMatchObject({ attempts: 1 });
  });
});

describe('health', () => {
  it('answers live and ready with counts only, and stops being ready on SIGTERM', async () => {
    await begin();
    const w = worker({ WORKER_ID: 'healthy', WORKER_DRAIN_SECONDS: '20' });
    const port = await until('the health port', async () => {
      const m = /"event":"health-listening"[^}]*"count":(\d+)/.exec(w.output());
      return m ? Number(m[1]) : undefined;
    });
    const get = async (path: string) => {
      const r = await fetch(`http://127.0.0.1:${port}${path}`);
      return { status: r.status, body: await r.text() };
    };
    const live = await until('live', async () => {
      const r = await get('/livez');
      return r.status === 200 ? r : undefined;
    });
    expect(JSON.parse(live.body)).toEqual({ status: 'ok', running: 0, stopping: false });
    expect((await get('/readyz')).status).toBe(200);
    expect((await get('/nothing')).status).toBe(404);
    const id = await enqueue('test.slow', { ms: 3_000 });
    await until('the job to start', async () => (await effects.files()).includes(`${id}.started`));
    await requestShutdown(w);
    // While draining the listener is closed to new connections or answers not-ready; either way it is no longer ready.
    await expectStoppedReadiness(() => get('/readyz'));
    expect(await w.exited).toEqual({ code: 0, signal: null });
    expect(await stateOf(id)).toBe('succeeded');
  });

  it('waits for child shutdown acknowledgement when SIGTERM handling is held', async () => {
    await begin();
    const id = await enqueue('test.slow', { ms: 3_000 });
    const preload = pathToFileURL(join(__dirname, 'fixtures', 'signal-gate.mjs')).href;
    const w = worker({ WORKER_ID: 'held-signal', WORKER_DRAIN_SECONDS: '20', NODE_OPTIONS: `--import=${preload}`, WORKER_TEST_SIGNAL_GATE_DIR: effects.dir });
    const port = await until('the health port', async () => Number(/"event":"health-listening"[^}]*"count":(\d+)/.exec(w.output())?.[1]) || undefined);
    const get = async () => {
      const response = await fetch(`http://127.0.0.1:${port}/readyz`);
      return { status: response.status, body: await response.text() };
    };
    await until('the job to start', async () => (await effects.files()).includes(`${id}.started`));
    expect((await get()).status).toBe(200);
    let acknowledged = false;
    const stopping = requestShutdown(w).then(() => { acknowledged = true; });
    // The original promise is joined in finally; observe rejection while checking the gate.
    void stopping.catch(() => undefined);
    try {
      await until('the signal to reach the test gate', async () => (await effects.files()).includes('signal-held'));
      expect(acknowledged).toBe(false);
      // The real worker is still ready until its application signal callback is released.
      expect((await get()).status).toBe(200);
      await writeFile(join(effects.dir, 'release-signal'), 'release\n', { flag: 'wx' });
      await stopping;
      expect(acknowledged).toBe(true);
      await expectStoppedReadiness(get);
      expect(await w.exited).toEqual({ code: 0, signal: null });
      expect(await stateOf(id)).toBe('succeeded');
    } finally {
      await writeFile(join(effects.dir, 'release-signal'), 'release\n');
      await stopping;
    }
  });

  it('accepts only stopped readiness or known closed connections, and propagates unrelated errors', async () => {
    await expectStoppedReadiness(async () => ({ status: 503, body: JSON.stringify({ status: 'unavailable', running: 1, stopping: true }) }));
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'UND_ERR_SOCKET']) {
      await expectStoppedReadiness(async () => { throw new TypeError('fetch failed', { cause: { code } }); });
    }
    for (const unrelated of [new TypeError('fetch failed', { cause: { code: 'EACCES' } }), new Error('unrelated request failure'), null]) {
      await expect(expectStoppedReadiness(async () => { throw unrelated; })).rejects.toBe(unrelated);
    }
    for (const response of [
      { status: 200, body: '{}' },
      { status: 404, body: '' },
      { status: 503, body: JSON.stringify({ status: 'unavailable', running: 1, stopping: false }) },
    ]) {
      await expect(expectStoppedReadiness(async () => response)).rejects.toThrow();
    }
  });
});

describe('queue statistics', () => {
  it('logs the depth and the age of the oldest ready job as one line, which is what the alarms read', async () => {
    await begin();
    const w = worker({ WORKER_ID: 'stats', WORKER_STATS_SECONDS: '10' });
    const line = await until('a queue-stats line', async () => w.output().split('\n').find((l) => l.includes('"event":"queue-stats"')));
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed).toMatchObject({ event: 'queue-stats', level: 'info', service: 'worker', count: expect.any(Number), running: expect.any(Number), dead: expect.any(Number), ageSeconds: expect.any(Number) });
    w.child.kill('SIGTERM');
    expect(await w.exited).toEqual({ code: 0, signal: null });
  });
});

describe('start-up refusals', () => {
  const run = (env: Record<string, string>) =>
    spawnSync(process.execPath, [join(__dirname, '..', 'dist', 'main.js')], { env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8', timeout: 20_000 });

  it('refuses a missing database setting, a URL with TLS parameters, and test jobs in production, without echoing a value', () => {
    const secret = 'postgres://telesphoros_worker:hunter2-password@db.example:5432/app';
    const cases: Record<string, string>[] = [{}, { DATABASE_URL: `${secret}?sslmode=disable` }, { DATABASE_URL: secret, NODE_ENV: 'production', WORKER_TEST_JOBS: 'yes', WORKER_TEST_EFFECT_DIR: '/tmp/x', DATABASE_SSL: 'require' }, { DATABASE_URL: secret, NODE_ENV: 'production' }, { DATABASE_URL: secret, WORKER_CONCURRENCY: '0' }, { DATABASE_URL: secret, WORKER_TEST_JOBS: 'yes' }];
    for (const env of cases) {
      const r = run(env);
      expect(r.status, JSON.stringify(Object.keys(env))).toBe(1);
      expect(r.stderr).toContain('worker failed to start');
      expect(r.stderr + r.stdout).not.toContain('hunter2');
    }
  });
});

describe('what a worker writes to its log', () => {
  it('never contains a value from a job or from a thrown error', async () => {
    await begin();
    const id = await enqueue('test.throw', {});
    const w = worker({ WORKER_ID: 'quiet' });
    await until('the job to fail', async () => ['retry', 'dead'].includes(await stateOf(id)));
    w.child.kill('SIGTERM');
    await w.exited;
    expect(w.output()).toContain(id);
    expect(w.output()).not.toContain('Jane');
    expect(w.output()).not.toContain('patient');
    for (const line of w.output().trim().split('\n')) expect(() => JSON.parse(line)).not.toThrow();
  });
});
