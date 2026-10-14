import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { REPORTS_BUCKET, TENANT_A, createFixture, s3Client, seedReport, startWorker, until, type Fixture, type WorkerProcess } from './support';
import type { S3Client } from '@aws-sdk/client-s3';

// The built worker process on its own: the outbox relay, the scheduler, the claim loop and the two consumers, with nothing but the environment to configure it.
let f: Fixture;
let s3: S3Client;
let started: WorkerProcess[] = [];
beforeAll(async () => {
  f = await createFixture();
  s3 = await s3Client();
});
afterAll(async () => f.close());
afterEach(async () => {
  for (const w of started) {
    w.child.kill('SIGKILL');
    await w.exited;
  }
  started = [];
});

const worker = (env: Record<string, string> = {}, options: { withoutBucket?: boolean } = {}) => {
  const w = startWorker(f.db, {
    ...(options.withoutBucket ? {} : { REPORTS_BUCKET }), S3_ENDPOINT: process.env.TEST_S3_ENDPOINT!, S3_FORCE_PATH_STYLE: 'true', AWS_REGION: 'us-east-2', AWS_ACCESS_KEY_ID: 'synthetic', AWS_SECRET_ACCESS_KEY: 'synthetic',
    WORKER_TEST_JOBS: 'no', WORKER_RELAY_SECONDS: '1', WORKER_SCHEDULE_TICK_SECONDS: '5', ...env,
  });
  started.push(w);
  return w;
};
const commitEvent = async (tenant: string, reportId: string) => {
  const c = new Client({ connectionString: f.db.appUrl });
  await c.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenant]);
    await c.query(`SELECT outbox_append('report.file-committed', $1)`, [reportId]);
    await c.query('COMMIT');
  } finally {
    await c.end();
  }
};

describe('the worker process with the consumers', () => {
  it('relays a committed upload\'s event into a job and re-checks the stored file with nothing else to start it', async () => {
    const good = await seedReport(f, s3, TENANT_A);
    const bad = await seedReport(f, s3, TENANT_A, { claim: { sha256: 'f'.repeat(64) } });
    await commitEvent(TENANT_A, good.reportId);
    await commitEvent(TENANT_A, bad.reportId);
    const w = worker({ WORKER_ID: 'consumers-1' });
    const rows = (id: string) => f.admin.query('SELECT outcome, reason FROM file_verifications WHERE report_id = $1', [id]).then((r) => r.rows);
    await until('both files to be checked', async () => (await rows(good.reportId)).length > 0 && (await rows(bad.reportId)).length > 0);
    expect(await rows(good.reportId)).toEqual([{ outcome: 'ok', reason: null }]);
    expect(await rows(bad.reportId)).toEqual([{ outcome: 'changed', reason: 'hash-mismatch' }]);
    const jobs = (await f.admin.query(`SELECT state, last_error_code FROM jobs WHERE type = 'files.verify-stored' ORDER BY seq`)).rows;
    expect(jobs).toEqual(expect.arrayContaining([{ state: 'succeeded', last_error_code: null }, { state: 'dead', last_error_code: 'file-changed' }]));
    expect(w.output()).not.toContain(good.key);
    expect(w.output()).not.toContain(bad.reportId);
  });

  it('runs the scheduled sweep for every active organization from the migration\'s own schedule, once per slot', async () => {
    await f.admin.query(`INSERT INTO job_schedules (type, interval_seconds) VALUES ('uploads.sweep', 3600) ON CONFLICT DO NOTHING`);
    worker({ WORKER_ID: 'consumers-2' });
    await until('the sweeps to succeed', async () => (await f.admin.query(`SELECT count(*)::int AS n FROM jobs WHERE type = 'uploads.sweep' AND state = 'succeeded'`)).rows[0].n >= 2);
    const swept = (await f.admin.query(`SELECT tenant_id, requested_by FROM jobs WHERE type = 'uploads.sweep' ORDER BY tenant_id`)).rows;
    expect(swept.map((r) => r.requested_by)).toEqual(swept.map(() => 'system:scheduler'));
    expect(swept.map((r) => r.tenant_id)).not.toContain('worker-test-suspended');
    await new Promise((r) => setTimeout(r, 6_500)); // another tick in the same slot adds nothing
    expect((await f.admin.query(`SELECT count(*)::int AS n FROM jobs WHERE type = 'uploads.sweep'`)).rows[0].n).toBe(swept.length);
  }, 30_000);

  it('does not register the file jobs without a bucket (outside production), says so, and still runs the sweep', async () => {
    const w = worker({ WORKER_ID: 'consumers-3' }, { withoutBucket: true });
    await until('the worker to say so', async () => w.output().includes('job-types-disabled') && w.output().includes('worker-started'));
    expect(w.output()).toContain('no-reports-bucket');
    expect(w.output()).not.toContain('worker failed to start');
  });
});
