import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { JobQueue } from '@telesphoros/jobs';
import { filesVerifyJobs } from '../src/handlers/files-verify';
import { uploadsSweepJob } from '../src/handlers/uploads-sweep';
import { PgJobData } from '../src/job-data';
import { jsonLogger, silentLogger } from '../src/log';
import { Runner } from '../src/runner';
import { S3ObjectInspector } from '../src/storage';
import { PERSON, REPORTS_BUCKET, TENANT_A, TENANT_B, TENANT_SUSPENDED, createFixture, enqueueAs, jobRow, s3Client, seedReport, until, type Fixture } from './support';

let f: Fixture;
let s3: S3Client;
let queue: JobQueue;
let lines: string[] = [];
let runner: Runner | undefined;
let n = 0;

beforeAll(async () => {
  f = await createFixture();
  s3 = await s3Client();
  queue = new JobQueue(f.worker);
});
afterAll(async () => f.close());
afterEach(async () => {
  await runner?.stop();
  runner = undefined;
});

function start(): Runner {
  lines = [];
  const log = jsonLogger((l) => lines.push(l));
  const deps = { data: new PgJobData(f.worker), inspector: new S3ObjectInspector(s3, REPORTS_BUCKET), log };
  runner = new Runner({ workerId: 'consumer-test', queue, jobs: [uploadsSweepJob(deps), ...filesVerifyJobs(deps)], concurrency: 4, tenantCap: 10, pollMs: 50, drainSeconds: 5, log });
  runner.start();
  return runner;
}
const verifications = (reportId: string) => f.admin.query('SELECT * FROM file_verifications WHERE report_id = $1 ORDER BY seq', [reportId]).then((r) => r.rows);
const stateOf = async (id: string) => (await jobRow(f.admin, id)).state as string;
const finished = (id: string) => until(`job ${id} to finish`, async () => ['succeeded', 'dead'].includes(await stateOf(id)));
/** The API's step: the upload commit writes the event inside its transaction. */
async function commitEvent(tenant: string, reportId: string): Promise<void> {
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
}
const verifyJobFor = async (reportId: string) => {
  await queue.relayOutbox(500);
  return (await f.admin.query(`SELECT id FROM jobs WHERE type = 'files.verify-stored' AND payload ->> 'reportId' = $1`, [reportId])).rows[0]!.id as string;
};

describe('a committed upload is re-checked end to end (event, relay, claim, handler, record)', () => {
  it('records ok for a file that matches, and the job succeeds', async () => {
    const r = await seedReport(f, s3, TENANT_A);
    await commitEvent(TENANT_A, r.reportId);
    const jobId = await verifyJobFor(r.reportId);
    start();
    await finished(jobId);
    expect(await stateOf(jobId)).toBe('succeeded');
    expect(await verifications(r.reportId)).toMatchObject([{ tenant_id: TENANT_A, job_id: jobId, source: 'upload', outcome: 'ok', reason: null, object_version: r.version }]);
  });

  it('reads the PINNED version: a later overwrite or a delete marker on the latest object does not change the answer', async () => {
    const r = await seedReport(f, s3, TENANT_A);
    await s3.send(new PutObjectCommand({ Bucket: REPORTS_BUCKET, Key: r.key, Body: Buffer.from('a different file'), ContentType: 'text/plain' }));
    await s3.send(new DeleteObjectCommand({ Bucket: REPORTS_BUCKET, Key: r.key }));
    await commitEvent(TENANT_A, r.reportId);
    const jobId = await verifyJobFor(r.reportId);
    start();
    await finished(jobId);
    expect(await stateOf(jobId)).toBe('succeeded');
    expect((await verifications(r.reportId))[0]).toMatchObject({ outcome: 'ok', object_version: r.version });
  });

  it.each([
    ['a version the bucket does not have', { pinVersion: 'not-a-version-of-this-object' }, 'missing', 'version-missing', 'file-missing'],
    ['bytes that differ from the report\'s hash', { claim: { sha256: 'c'.repeat(64) } }, 'changed', 'hash-mismatch', 'file-changed'],
    ['a size that differs from the report\'s', { claim: { sizeBytes: 5 } }, 'changed', 'size-mismatch', 'file-changed'],
    ['a content type that differs from the report\'s', { claim: { contentType: 'application/json' } }, 'changed', 'type-mismatch', 'file-changed'],
  ])('finds %s, records it, and ends the job dead without touching the file', async (_name, options, outcome, reason, code) => {
    const r = await seedReport(f, s3, TENANT_A, options);
    await commitEvent(TENANT_A, r.reportId);
    const jobId = await verifyJobFor(r.reportId);
    start();
    await finished(jobId);
    expect(await jobRow(f.admin, jobId)).toMatchObject({ state: 'dead', last_error_code: code, attempts: 1 });
    expect(await verifications(r.reportId)).toMatchObject([{ outcome, reason }]);
    // The stored object is exactly as it was (nothing is repaired or deleted).
    if (!('pinVersion' in options)) expect(await new S3ObjectInspector(s3, REPORTS_BUCKET).inspect(r.key, r.version, { maxBytes: 1_000_000 })).toMatchObject({ sizeBytes: r.bytes.length });
  });

  it('surfaces an abort from the real store as a thrown error, never as a verdict (the handler treats a throw with an aborted signal as a retry, not a finding)', async () => {
    const r = await seedReport(f, s3, TENANT_A);
    const controller = new AbortController();
    controller.abort();
    await expect(new S3ObjectInspector(s3, REPORTS_BUCKET).inspect(r.key, r.version, { maxBytes: 1_000_000, signal: controller.signal })).rejects.toBeDefined();
    expect(await verifications(r.reportId)).toEqual([]); // and nothing was recorded by reading
  });

  it('succeeds without a record when the report is gone', async () => {
    const ghost = randomUUID();
    await commitEvent(TENANT_A, ghost);
    const jobId = await verifyJobFor(ghost);
    start();
    await finished(jobId);
    expect(await stateOf(jobId)).toBe('succeeded');
    expect(await verifications(ghost)).toEqual([]);
  });

  it('logs the job, the outcome and a reason code, never a key, a version or a hash', async () => {
    const r = await seedReport(f, s3, TENANT_A, { claim: { sha256: 'd'.repeat(64) } });
    await commitEvent(TENANT_A, r.reportId);
    const jobId = await verifyJobFor(r.reportId);
    start();
    await finished(jobId);
    const text = lines.join('\n');
    expect(text).toContain('file-verified');
    for (const secret of [r.key, r.version, 'd'.repeat(64), r.reportId]) expect(text).not.toContain(secret);
  });
});

describe('a suspended organization', () => {
  it('has its re-check made but not run while it is suspended, and run once it is active again', async () => {
    await f.admin.query(`UPDATE tenants SET status = 'active' WHERE id = $1`, [TENANT_SUSPENDED]);
    const r = await seedReport(f, s3, TENANT_SUSPENDED);
    await commitEvent(TENANT_SUSPENDED, r.reportId);
    await f.admin.query(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [TENANT_SUSPENDED]);
    const jobId = await verifyJobFor(r.reportId);
    start();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(await stateOf(jobId)).toBe('queued');
    expect(await verifications(r.reportId)).toEqual([]);
    await f.admin.query(`UPDATE tenants SET status = 'active' WHERE id = $1`, [TENANT_SUSPENDED]);
    try {
      await finished(jobId);
      expect(await stateOf(jobId)).toBe('succeeded');
      expect(await verifications(r.reportId)).toMatchObject([{ outcome: 'ok' }]);
    } finally {
      await f.admin.query(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [TENANT_SUSPENDED]);
    }
  });
});

describe('the scheduled integrity re-check (files.verify-stale)', () => {
  it('checks an organization\'s unchecked reports first, only its own, and leaves fresh ones alone until they age', async () => {
    const mine = await Promise.all([seedReport(f, s3, TENANT_A), seedReport(f, s3, TENANT_A)]);
    const theirs = await seedReport(f, s3, TENANT_B);
    start();
    const first = (await enqueueAs(f.db, TENANT_A, PERSON, 'files.verify-stale', {}, `stale-${++n}`)).jobId;
    await finished(first);
    expect(await stateOf(first)).toBe('succeeded');
    for (const r of mine) expect(await verifications(r.reportId), r.reportId).toMatchObject([{ source: 'scheduled', outcome: 'ok', job_id: first }]);
    expect(await verifications(theirs.reportId)).toEqual([]); // another organization's report is not this job's
    // A second run right away has nothing stale to do.
    const second = (await enqueueAs(f.db, TENANT_A, PERSON, 'files.verify-stale', {}, `stale-${++n}`)).jobId;
    await finished(second);
    for (const r of mine) expect(await verifications(r.reportId)).toHaveLength(1);
    // Age one report's last check past the window (the table is append-only; the test steps around its trigger the way only a superuser can).
    const c = await f.admin.connect();
    try {
      await c.query(`SET session_replication_role = replica`);
      await c.query(`UPDATE file_verifications SET verified_at = now() - interval '40 days' WHERE report_id = $1`, [mine[0]!.reportId]);
    } finally {
      await c.query(`RESET session_replication_role`);
      c.release();
    }
    const third = (await enqueueAs(f.db, TENANT_A, PERSON, 'files.verify-stale', {}, `stale-${++n}`)).jobId;
    await finished(third);
    expect(await verifications(mine[0]!.reportId)).toHaveLength(2);
    expect(await verifications(mine[1]!.reportId)).toHaveLength(1);
  });

  it('records every finding and then ends the job dead', async () => {
    const bad = await seedReport(f, s3, TENANT_B, { claim: { sha256: 'e'.repeat(64) } });
    const good = await seedReport(f, s3, TENANT_B);
    start();
    const jobId = (await enqueueAs(f.db, TENANT_B, PERSON, 'files.verify-stale', {}, `stale-${++n}`)).jobId;
    await finished(jobId);
    expect(await jobRow(f.admin, jobId)).toMatchObject({ state: 'dead', last_error_code: 'file-changed' });
    expect(await verifications(bad.reportId)).toMatchObject([{ outcome: 'changed', reason: 'hash-mismatch' }]);
    expect(await verifications(good.reportId)).toMatchObject([{ outcome: 'ok' }]);
  });
});

describe('a read that failed is not a check (files.verify-stale)', () => {
  // Its own organization, so the reports of the other tests (and the finding one of them leaves) are not in the batch.
  const GAMMA = 'worker-test-gamma';
  beforeAll(async () => {
    await f.admin.query(`INSERT INTO tenants (id, display_name, status, created_by, changed_by) VALUES ($1, $1, 'active', 'worker-test', 'worker-test')`, [GAMMA]);
  });

  async function hold(): Promise<{ jobId: string; worker: Client }> {
    const jobId = (await enqueueAs(f.db, GAMMA, PERSON, 'files.verify-stale', {}, `unreadable-${++n}`)).jobId;
    await f.admin.query(`UPDATE jobs SET state = 'running', locked_by = 'holder', lease_until = now() + interval '5 minutes', attempts = 1, started_at = now() WHERE id = $1`, [jobId]);
    const worker = new Client({ connectionString: f.db.workerUrl });
    await worker.connect();
    return { jobId, worker };
  }
  const record = (worker: Client, jobId: string, r: { reportId: string; version: string }, outcome: string, reason: string | null) =>
    worker.query(`SELECT file_verification_record($1, 'holder', $2, $3, $4, $5)`, [jobId, r.reportId, outcome, reason, r.version]);
  /** Moves a report's rows of one outcome back in time (the table is append-only; the test steps around its trigger the way only a superuser can). */
  async function age(reportId: string, outcome: string, interval: string): Promise<void> {
    const c = await f.admin.connect();
    try {
      await c.query(`SET session_replication_role = replica`);
      await c.query(`UPDATE file_verifications SET verified_at = now() - $3::interval WHERE report_id = $1 AND outcome = $2`, [reportId, outcome, interval]);
    } finally {
      await c.query(`RESET session_replication_role`);
      c.release();
    }
  }
  /** What the scheduled job would be handed, in order, among the given reports (a day is the freshness window, so a check made now is fresh). */
  const due = async (worker: Client, jobId: string, ids: string[]) =>
    (await worker.query('SELECT report_id FROM file_verification_stale($1, $2, 200, 86400) WHERE report_id = ANY($3)', [jobId, 'holder', ids])).rows.map((r) => r.report_id as string);

  it('hands out a report whose last read failed, and leaves alone one that was just verified, or just found missing or changed', async () => {
    const [unreadable, ok, missing, changed, agedOkThenUnreadable] = await Promise.all([1, 2, 3, 4, 5].map(() => seedReport(f, s3, GAMMA)));
    const { jobId, worker } = await hold();
    try {
      await record(worker, jobId, unreadable!, 'unreadable', 'storage-error');
      await record(worker, jobId, ok!, 'ok', null);
      await record(worker, jobId, missing!, 'missing', 'version-missing');
      await record(worker, jobId, changed!, 'changed', 'hash-mismatch');
      await record(worker, jobId, agedOkThenUnreadable!, 'ok', null);
      await age(agedOkThenUnreadable!.reportId, 'ok', '90 days'); // its last real check is old...
      await record(worker, jobId, agedOkThenUnreadable!, 'unreadable', 'storage-error'); // ...and the failed read since then tells nothing about the file
      const ids = [unreadable!, ok!, missing!, changed!, agedOkThenUnreadable!].map((r) => r.reportId);
      expect((await due(worker, jobId, ids)).sort()).toEqual([unreadable!.reportId, agedOkThenUnreadable!.reportId].sort());
    } finally {
      await worker.end();
    }
  });

  it('hands out the never-attempted first, then the least recently attempted, so a report that keeps failing goes to the back instead of starving the rest', async () => {
    const [never, okOld, unreadableOld, unreadableNow] = await Promise.all([1, 2, 3, 4].map(() => seedReport(f, s3, GAMMA)));
    const { jobId, worker } = await hold();
    try {
      await record(worker, jobId, okOld!, 'ok', null);
      await age(okOld!.reportId, 'ok', '90 days');
      await record(worker, jobId, unreadableOld!, 'unreadable', 'storage-error');
      await age(unreadableOld!.reportId, 'unreadable', '5 days');
      await record(worker, jobId, unreadableNow!, 'unreadable', 'storage-error');
      const ids = [never!, okOld!, unreadableOld!, unreadableNow!].map((r) => r.reportId);
      expect(await due(worker, jobId, [...ids].reverse())).toEqual(ids);
    } finally {
      await worker.end();
    }
  });

  it('a retry of the same job looks again at the report the first attempt could not read, and a good read then ends it', async () => {
    const r = await seedReport(f, s3, GAMMA);
    const { jobId, worker } = await hold();
    try {
      let storeDown = true;
      const real = new S3ObjectInspector(s3, REPORTS_BUCKET);
      const inspector = { inspect: (key: string, version: string, options: { maxBytes: number; signal?: AbortSignal }) => (storeDown ? Promise.reject(new Error('socket hang up')) : real.inspect(key, version, options)) };
      const job = filesVerifyJobs({ data: new PgJobData(f.worker), inspector, log: silentLogger }).find((j) => j.definition.type === 'files.verify-stale')!;
      const context = { job: { id: jobId, type: 'files.verify-stale' }, workerId: 'holder', signal: new AbortController().signal } as unknown as Parameters<typeof job.handler>[0];
      // The store is down: every report in the organization is recorded unreadable and the attempt asks to be retried.
      await expect(job.handler(context)).rejects.toMatchObject({ code: 'storage-unreadable', retryable: true });
      expect((await verifications(r.reportId)).map((v) => v.outcome)).toEqual(['unreadable']);
      // The store is back. The retry must pick the same report up again, not treat the failed read as a check.
      storeDown = false;
      await job.handler(context);
      expect((await verifications(r.reportId)).map((v) => v.outcome)).toEqual(['unreadable', 'ok']);
      // Now it is checked: another run has nothing to do for it (control).
      expect(await due(worker, jobId, [r.reportId])).toEqual([]);
    } finally {
      await worker.end();
    }
  });
});

describe('the worker may reach these functions only through a job it holds', () => {
  async function held(type: string, payload: unknown, tenant = TENANT_A): Promise<{ jobId: string; worker: Client }> {
    const jobId = (await enqueueAs(f.db, tenant, PERSON, type, payload, `held-${++n}`)).jobId;
    await f.admin.query(`UPDATE jobs SET state = 'running', locked_by = 'holder', lease_until = now() + interval '5 minutes', attempts = 1, started_at = now() WHERE id = $1`, [jobId]);
    const worker = new Client({ connectionString: f.db.workerUrl });
    await worker.connect();
    return { jobId, worker };
  }

  it('refuses a job it does not hold, a job of another type, and a finished job', async () => {
    const r = await seedReport(f, s3, TENANT_A);
    const { jobId, worker } = await held('files.verify-stored', { reportId: r.reportId });
    try {
      await expect(worker.query('SELECT * FROM file_verification_target($1, $2)', [jobId, 'intruder'])).rejects.toThrow(/does not hold that job/);
      await expect(worker.query('SELECT * FROM file_verification_target($1, $2)', [randomUUID(), 'holder'])).rejects.toThrow(/does not hold that job/);
      await expect(worker.query('SELECT * FROM job_uploads_sweep($1, $2)', [jobId, 'holder'])).rejects.toThrow(/does not hold that job/);
      await expect(worker.query('SELECT * FROM file_verification_stale($1, $2, 5, 3600)', [jobId, 'holder'])).rejects.toThrow(/does not hold that job/);
      expect((await worker.query('SELECT * FROM file_verification_target($1, $2)', [jobId, 'holder'])).rows).toHaveLength(1); // control
      await f.admin.query(`UPDATE jobs SET state = 'succeeded', lease_until = NULL, locked_by = NULL, finished_at = now() WHERE id = $1`, [jobId]);
      await expect(worker.query('SELECT * FROM file_verification_target($1, $2)', [jobId, 'holder'])).rejects.toThrow(/does not hold that job/);
    } finally {
      await worker.end();
    }
  });

  it('records only about the report its job names, only for the job\'s organization, and never a made-up outcome', async () => {
    const mine = await seedReport(f, s3, TENANT_A);
    const other = await seedReport(f, s3, TENANT_A);
    const foreign = await seedReport(f, s3, TENANT_B);
    const { jobId, worker } = await held('files.verify-stored', { reportId: mine.reportId });
    try {
      await expect(worker.query(`SELECT file_verification_record($1, 'holder', $2, 'ok', NULL, 'v')`, [jobId, other.reportId])).rejects.toThrow(/verifies one report/);
      await expect(worker.query(`SELECT file_verification_record($1, 'holder', $2, 'ok', NULL, 'v')`, [jobId, foreign.reportId])).rejects.toThrow(/verifies one report/);
      await expect(worker.query(`SELECT file_verification_record($1, 'holder', $2, 'fine', NULL, 'v')`, [jobId, mine.reportId])).rejects.toThrow(/file_verifications_outcome_check/);
      await expect(worker.query(`SELECT file_verification_record($1, 'holder', $2, 'missing', 'Jane Doe', 'v')`, [jobId, mine.reportId])).rejects.toThrow(/file_verifications_reason_check/);
      await expect(worker.query(`SELECT file_verification_record($1, 'holder', $2, 'ok', 'should-be-null', 'v')`, [jobId, mine.reportId])).rejects.toThrow(/file_verifications_reason_check/);
      expect(await verifications(mine.reportId)).toEqual([]);
    } finally {
      await worker.end();
    }
  });

  it('hands out the never-checked first, then the longest unchecked, and no more than asked', async () => {
    const reportsOf = await Promise.all([seedReport(f, s3, TENANT_B), seedReport(f, s3, TENANT_B), seedReport(f, s3, TENANT_B)]);
    const [older, newer, never] = reportsOf;
    const { jobId, worker } = await held('files.verify-stale', {}, TENANT_B);
    try {
      for (const r of [older!, newer!]) await worker.query(`SELECT file_verification_record($1, 'holder', $2, 'ok', NULL, $3)`, [jobId, r.reportId, r.version]);
      const c = await f.admin.connect();
      try {
        await c.query(`SET session_replication_role = replica`);
        await c.query(`UPDATE file_verifications SET verified_at = now() - interval '90 days' WHERE report_id = $1`, [older!.reportId]);
        await c.query(`UPDATE file_verifications SET verified_at = now() - interval '45 days' WHERE report_id = $1`, [newer!.reportId]);
      } finally {
        await c.query(`RESET session_replication_role`);
        c.release();
      }
      const order = async (limit: number) => (await worker.query('SELECT report_id FROM file_verification_stale($1, $2, $3, 86400) WHERE report_id = ANY($4)', [jobId, 'holder', limit + 20, reportsOf.map((r) => r.reportId)])).rows.map((r) => r.report_id as string);
      expect(await order(0)).toEqual([never!.reportId, older!.reportId, newer!.reportId]);
      expect((await worker.query('SELECT report_id FROM file_verification_stale($1, $2, 1, 86400)', [jobId, 'holder'])).rows).toHaveLength(1);
    } finally {
      await worker.end();
    }
  });

  it('cannot read another organization\'s reports through a stale job, and cannot call the sweep directly', async () => {
    const a = await seedReport(f, s3, TENANT_A);
    const { jobId, worker } = await held('files.verify-stale', {}, TENANT_B);
    try {
      const rows = (await worker.query('SELECT * FROM file_verification_stale($1, $2, 200, 60)', [jobId, 'holder'])).rows;
      expect(rows.map((r) => r.report_id)).not.toContain(a.reportId);
      await expect(worker.query('SELECT * FROM uploads_sweep($1, 0, true)', [TENANT_A])).rejects.toThrow(/permission denied/);
      await expect(worker.query('SELECT file_verification_stale($1, $2, 0, 60)', [jobId, 'holder'])).rejects.toThrow(/out of range/);
      await expect(worker.query('SELECT file_verification_stale($1, $2, 5, 10)', [jobId, 'holder'])).rejects.toThrow(/out of range/);
    } finally {
      await worker.end();
    }
  });

  it('keeps the verification record append-only for the owner and readable to the application only within its organization', async () => {
    const r = await seedReport(f, s3, TENANT_A);
    await commitEvent(TENANT_A, r.reportId);
    const jobId = await verifyJobFor(r.reportId);
    start();
    await finished(jobId);
    await expect(f.admin.query('UPDATE file_verifications SET outcome = $1 WHERE report_id = $2', ['changed', r.reportId])).rejects.toThrow();
    await expect(f.admin.query('DELETE FROM file_verifications WHERE report_id = $1', [r.reportId])).rejects.toThrow();
    const a = new Client({ connectionString: f.db.appUrl });
    await a.connect();
    try {
      expect((await a.query('SELECT count(*)::int AS n FROM file_verifications')).rows[0].n).toBe(0); // no organization bound: nothing
      await a.query('BEGIN');
      await a.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [TENANT_B]);
      expect((await a.query('SELECT count(*)::int AS n FROM file_verifications WHERE report_id = $1', [r.reportId])).rows[0].n).toBe(0);
      await a.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [TENANT_A]);
      expect((await a.query('SELECT count(*)::int AS n FROM file_verifications WHERE report_id = $1', [r.reportId])).rows[0].n).toBe(1);
      await a.query('ROLLBACK');
      await expect(a.query(`INSERT INTO file_verifications (tenant_id, report_id, job_id, source, outcome, object_version) VALUES ('${TENANT_A}', '${r.reportId}', '${jobId}', 'upload', 'ok', 'v')`)).rejects.toThrow(/permission denied/);
    } finally {
      await a.end();
    }
  });
});
