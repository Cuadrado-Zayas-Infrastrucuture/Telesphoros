import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { CreateBucketCommand, PutBucketVersioningCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, Pool } from 'pg';
import { createEphemeralDatabase, type EphemeralDatabase } from '../../backend/test/helpers/database';

export const TENANT_A = 'worker-test-alpha';
export const TENANT_B = 'worker-test-beta';
export const TENANT_SUSPENDED = 'worker-test-suspended';
export const PERSON = '11111111-aaaa-4aaa-8aaa-111111111111';

export interface Fixture {
  db: EphemeralDatabase;
  /** A worker-login pool: exactly what the worker process holds. */
  worker: Pool;
  /** Superuser, for set-up and for reading what the logins cannot (and for backdating leases). */
  admin: Pool;
  close(): Promise<void>;
}

export async function createFixture(): Promise<Fixture> {
  const db = await createEphemeralDatabase();
  const worker = new Pool({ connectionString: db.workerUrl, max: 12 });
  const admin = new Pool({ connectionString: db.adminUrl, max: 4 });
  // Dropping the database (WITH FORCE) ends any connection still open; that is not a test failure.
  for (const pool of [worker, admin]) pool.on('error', () => undefined);
  for (const [id, status] of [
    [TENANT_A, 'active'],
    [TENANT_B, 'active'],
    [TENANT_SUSPENDED, 'suspended'],
  ]) {
    await admin.query(`INSERT INTO tenants (id, display_name, status, created_by, changed_by) VALUES ($1, $1, $2, 'worker-test', 'worker-test')`, [id, status]);
  }
  // The migrations seed the recurring jobs (hourly sweep, daily re-check). These tests enqueue what they need themselves, so a worker under test does not also run those.
  await admin.query('DELETE FROM job_schedules');
  return {
    db,
    worker,
    admin,
    async close() {
      await worker.end();
      await admin.end();
      await db.drop();
    },
  };
}

/** Enqueues the way the API does: as the application login, inside a transaction that binds the organization and the person. */
export async function enqueueAs(
  db: EphemeralDatabase,
  tenant: string | undefined,
  actor: string | undefined,
  type: string,
  payload: unknown,
  key: string,
  options: { runAfter?: Date; maxAttempts?: number } = {},
): Promise<{ jobId: string; created: boolean }> {
  const client = new Client({ connectionString: db.appUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    if (tenant) await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenant]);
    if (actor) await client.query(`SELECT set_config('app.current_actor', $1, true)`, [actor]);
    const { rows } = await client.query('SELECT job_id, created FROM job_enqueue($1, $2::jsonb, $3, $4, $5)', [
      type,
      JSON.stringify(payload),
      key,
      options.runAfter ?? new Date(),
      options.maxAttempts ?? 3,
    ]);
    await client.query('COMMIT');
    return { jobId: rows[0].job_id as string, created: rows[0].created as boolean };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

/** What a runner records as holding a job: its worker id and a part new on every claim (audit W2). */
export const heldBy = (workerId: string) => new RegExp(`^${workerId.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}#[0-9a-f]{8}$`);

export async function jobRow(admin: Pool, id: string): Promise<Record<string, unknown>> {
  return (await admin.query('SELECT * FROM jobs WHERE id = $1', [id])).rows[0];
}

export async function attemptsOf(admin: Pool, id: string): Promise<{ attempt: number; outcome: string; error_code: string | null; worker_id: string }[]> {
  return (await admin.query('SELECT attempt, outcome, error_code, worker_id FROM job_attempts WHERE job_id = $1 ORDER BY seq', [id])).rows;
}

export async function until<T>(what: string, check: () => Promise<T | undefined | false>, timeoutMs = 20_000, everyMs = 50): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

export async function effectDir(): Promise<{ dir: string; files(): Promise<string[]>; remove(): Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'worker-effects-'));
  return { dir, files: () => readdir(dir), remove: () => rm(dir, { recursive: true, force: true }) };
}

export interface WorkerProcess {
  child: ChildProcess;
  output(): string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/** Starts the built worker (`dist/main.js`) as a real process with its own database connections. */
export function startWorker(db: EphemeralDatabase, env: Record<string, string>): WorkerProcess {
  const child = spawn(process.execPath, [join(__dirname, '..', 'dist', 'main.js')], {
    env: {
      PATH: process.env.PATH ?? '',
      DATABASE_URL: db.workerUrl,
      WORKER_TEST_JOBS: 'yes',
      WORKER_POLL_MS: '100',
      WORKER_SCHEDULE_TICK_SECONDS: '5',
      WORKER_HEALTH_PORT: '0',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  return { child, output: () => out, exited };
}

export const REPORTS_BUCKET = 'worker-test-reports';

export async function s3Client(): Promise<S3Client> {
  const client = new S3Client({
    region: 'us-east-2',
    endpoint: process.env.TEST_S3_ENDPOINT,
    forcePathStyle: true,
    credentials: { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' },
  });
  await client.send(new CreateBucketCommand({ Bucket: REPORTS_BUCKET, CreateBucketConfiguration: { LocationConstraint: 'us-east-2' } })).catch(() => undefined);
  await client.send(new PutBucketVersioningCommand({ Bucket: REPORTS_BUCKET, VersioningConfiguration: { Status: 'Enabled' } }));
  return client;
}

export interface SeededReport {
  reportId: string;
  key: string;
  version: string;
  bytes: Buffer;
}

/**
 * A report whose file is really stored (Moto) and whose row is pinned to that stored version. `claim` overrides what the report says about the file (to make it disagree
 * with the object); `pinVersion` pins a version the bucket does not have.
 */
export async function seedReport(
  f: Fixture,
  s3: S3Client,
  tenant: string,
  options: { bytes?: Buffer; contentType?: string; claim?: { sha256?: string; sizeBytes?: number; contentType?: string }; pinVersion?: string } = {},
): Promise<SeededReport> {
  const reportId = randomUUID();
  const patientId = randomUUID();
  const bytes = options.bytes ?? Buffer.from(JSON.stringify({ synthetic: true, nonce: randomUUID() }));
  const contentType = options.contentType ?? 'application/json';
  const key = `reports/${tenant}/${reportId}/file`;
  const put = await s3.send(new PutObjectCommand({ Bucket: REPORTS_BUCKET, Key: key, Body: bytes, ContentType: contentType }));
  const version = options.pinVersion ?? put.VersionId!;
  await f.admin.query(`INSERT INTO patients (id, tenant_id, created_by, label) VALUES ($1, $2, 'worker-test', $3)`, [patientId, tenant, `SYN-${patientId.slice(0, 8)}`]);
  await f.admin.query(
    `INSERT INTO reports (id, tenant_id, created_by, patient_id, type, original_filename, size_bytes, status, content_type, sha256, storage_key, uploaded_at, object_version, upload_requested_by, uploaded_by)
     VALUES ($1, $2, 'worker-test', $3, 'structured', 'synthetic.json', $4, 'received', $5, $6, $7, now(), $8, 'worker-test', 'worker-test')`,
    [
      reportId,
      tenant,
      patientId,
      options.claim?.sizeBytes ?? bytes.length,
      options.claim?.contentType ?? contentType,
      options.claim?.sha256 ?? createHash('sha256').update(bytes).digest('hex'),
      key,
      version,
    ],
  );
  return { reportId, key, version, bytes };
}
