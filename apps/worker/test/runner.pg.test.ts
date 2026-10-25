import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { JobQueue } from '@telesphoros/jobs';
import { jsonLogger } from '../src/log';
import { Runner } from '../src/runner';
import { testJobs } from '../src/handlers/test-jobs';
import { PERSON, TENANT_A, TENANT_B, attemptsOf, createFixture, effectDir, enqueueAs, jobRow, until, type Fixture } from './support';

let f: Fixture;
let queue: JobQueue;
let effects: Awaited<ReturnType<typeof effectDir>>;
let lines: string[];
let runners: Runner[] = [];

beforeAll(async () => {
  f = await createFixture();
  queue = new JobQueue(f.worker);
});
afterAll(async () => f.close());
afterEach(async () => {
  await Promise.all(runners.map((r) => r.stop()));
  runners = [];
  await effects?.remove();
});

async function start(options: { id?: string; concurrency?: number; drainSeconds?: number; tenantCap?: number } = {}): Promise<Runner> {
  effects ??= await effectDir();
  const runner = new Runner({
    workerId: options.id ?? 'runner-1',
    queue,
    jobs: testJobs(effects.dir),
    concurrency: options.concurrency ?? 4,
    tenantCap: options.tenantCap ?? 10,
    pollMs: 50,
    drainSeconds: options.drainSeconds ?? 5,
    log: jsonLogger((line) => lines.push(line)),
  });
  runners.push(runner);
  runner.start();
  return runner;
}
const begin = async () => {
  lines = [];
  effects = await effectDir();
  await f.admin.query(`UPDATE jobs SET state = 'cancelled', lease_until = NULL, locked_by = NULL, finished_at = now() WHERE state IN ('queued', 'retry', 'running')`);
};
let n = 0;
const enqueue = (type: string, payload: unknown, options: { maxAttempts?: number } = {}) =>
  enqueueAs(f.db, TENANT_A, PERSON, type, payload, `r-${++n}`, options).then((r) => r.jobId);
const state = (id: string) => jobRow(f.admin, id).then((r) => r.state as string);
const settled = (id: string, wanted: string[]) => until(`job ${id} to be ${wanted.join('/')}`, async () => wanted.includes(await state(id)));

describe('the claim loop', () => {
  it('runs a job to completion as the system actor and records one succeeded attempt', async () => {
    await begin();
    const id = await enqueue('test.echo', { n: 1 });
    await start();
    await settled(id, ['succeeded']);
    expect(await effects.files()).toEqual(expect.arrayContaining([`${id}.done`]));
    expect(await attemptsOf(f.admin, id)).toEqual([{ attempt: 1, outcome: 'succeeded', error_code: null, worker_id: 'runner-1' }]);
    expect(await jobRow(f.admin, id)).toMatchObject({ locked_by: null, lease_until: null, last_error_code: null });
  });

  it('retries a retryable failure with its own code and makes a fatal one dead on the first run', async () => {
    await begin();
    const retry = await enqueue('test.fail', { code: 'upstream-timeout', canRetry: true });
    const fatal = await enqueue('test.fail', { code: 'bad-input', canRetry: false });
    await start();
    await settled(retry, ['retry']);
    await settled(fatal, ['dead']);
    expect(await jobRow(f.admin, retry)).toMatchObject({ state: 'retry', last_error_code: 'upstream-timeout', attempts: 1 });
    expect(await jobRow(f.admin, fatal)).toMatchObject({ state: 'dead', last_error_code: 'bad-input', attempts: 1 });
    // The retry waits about a minute: nothing runs it again meanwhile.
    await new Promise((r) => setTimeout(r, 400));
    expect((await effects.files()).filter((x) => x.startsWith(`${retry}.run-`))).toHaveLength(1);
  });

  it('turns an unexpected error into the code handler-error and never lets its message reach the database or a log', async () => {
    await begin();
    const id = await enqueue('test.throw', {}, { maxAttempts: 1 });
    await start();
    await settled(id, ['dead']);
    expect(await jobRow(f.admin, id)).toMatchObject({ last_error_code: 'handler-error' });
    expect(JSON.stringify((await f.admin.query('SELECT * FROM job_attempts WHERE job_id = $1', [id])).rows)).not.toContain('Jane');
    expect(lines.join('\n')).not.toContain('Jane');
    expect(lines.join('\n')).not.toContain('patient');
  });

  it('abandons a handler that outlives its timeout and fails the job with handler-timeout', async () => {
    await begin();
    const id = await enqueue('test.hang', {}, { maxAttempts: 1 });
    await start();
    await settled(id, ['dead']);
    expect(await jobRow(f.admin, id)).toMatchObject({ last_error_code: 'handler-timeout' });
  });

  it('kills at once a job whose payload no longer fits its definition (invalid-payload), without running it', async () => {
    await begin();
    const id = await enqueue('test.echo', { n: 'not-a-number' });
    await start();
    await settled(id, ['dead']);
    expect(await jobRow(f.admin, id)).toMatchObject({ last_error_code: 'invalid-payload' });
    expect((await effects.files()).filter((x) => x.startsWith(id))).toEqual([]);
  });

  it('keeps a long job leased with heartbeats so a second worker never runs it', async () => {
    await begin();
    const id = await enqueue('test.slow', { ms: 8_000 }); // lease is 5 seconds
    await start({ id: 'holder' });
    await until('the job to start', async () => (await effects.files()).includes(`${id}.started`));
    await start({ id: 'bystander' });
    await settled(id, ['succeeded']);
    const runs = (await effects.files()).filter((x) => x.startsWith(`${id}.run-`));
    expect(runs).toHaveLength(1);
    expect(await attemptsOf(f.admin, id)).toEqual([{ attempt: 1, outcome: 'succeeded', error_code: null, worker_id: 'holder' }]);
  }, 30_000);

  it('never runs more jobs at once than its concurrency, and holds an organization to the cap', async () => {
    await begin();
    for (let i = 0; i < 6; i += 1) await enqueue('test.slow', { ms: 700 });
    const runner = await start({ concurrency: 2 });
    let peak = 0;
    const watcher = setInterval(() => (peak = Math.max(peak, runner.activeCount)), 10);
    await until(
      'all six to finish',
      async () =>
        (
          await f.admin.query(
            `SELECT count(*)::int AS n FROM jobs WHERE state = 'succeeded' AND type = 'test.slow' AND tenant_id = $1 AND updated_at > now() - interval '1 minute'`,
            [TENANT_A],
          )
        ).rows[0].n >= 6,
    );
    clearInterval(watcher);
    expect(peak).toBe(2);
  });

  it('runs a job for each organization under the organization it belongs to', async () => {
    await begin();
    const a = await enqueue('test.echo', { n: 1 });
    const b = (await enqueueAs(f.db, TENANT_B, PERSON, 'test.echo', { n: 2 }, `r-${++n}`)).jobId;
    await start();
    await settled(a, ['succeeded']);
    await settled(b, ['succeeded']);
    expect(await jobRow(f.admin, b)).toMatchObject({ tenant_id: TENANT_B });
  });
});

describe('shutdown', () => {
  it('lets a running job finish when the drain allows it, then stops claiming', async () => {
    await begin();
    const id = await enqueue('test.slow', { ms: 600 });
    const runner = await start({ drainSeconds: 10 });
    await until('the job to start', async () => (await effects.files()).includes(`${id}.started`));
    await runner.stop();
    expect(await state(id)).toBe('succeeded');
    const later = await enqueue('test.echo', { n: 5 });
    await new Promise((r) => setTimeout(r, 300));
    expect(await state(later)).toBe('queued'); // a stopped worker claims nothing
  });

  it('releases what is still running when the drain runs out, without counting the attempt, and its late result is ignored', async () => {
    await begin();
    const id = await enqueue('test.slow', { ms: 20_000 });
    const runner = await start({ drainSeconds: 0 });
    await until('the job to start', async () => (await effects.files()).includes(`${id}.started`));
    await runner.stop();
    expect(await jobRow(f.admin, id)).toMatchObject({ state: 'queued', attempts: 0, locked_by: null, lease_until: null });
    expect((await attemptsOf(f.admin, id)).map((a) => a.outcome)).toEqual(['released']);
    // Another worker picks it up as a first attempt.
    await start({ id: 'second' });
    await until('the second worker to claim it', async () => (await jobRow(f.admin, id)).locked_by === 'second');
    expect(await jobRow(f.admin, id)).toMatchObject({ attempts: 1 });
  });
});

describe('logging', () => {
  it('names jobs by id, type, attempt and outcome code only', async () => {
    await begin();
    const id = await enqueue('test.fail', { code: 'upstream-timeout', canRetry: true });
    await start();
    await settled(id, ['retry']);
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const finished = parsed.find((l) => l.event === 'job-finished')!;
    expect(finished).toMatchObject({ jobId: id, jobType: 'test.fail', attempt: 1, outcome: 'retry', code: 'upstream-timeout', service: 'worker' });
    const allowed = new Set(['time', 'level', 'service', 'event', 'workerId', 'jobId', 'jobType', 'attempt', 'outcome', 'code', 'count', 'running', 'reason']);
    for (const l of parsed) for (const k of Object.keys(l)) expect(allowed.has(k)).toBe(true);
    expect(lines.join('\n')).not.toContain('upstream-timeout-with-a-value');
  });
});
