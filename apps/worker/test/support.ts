import { spawn, type ChildProcess } from 'node:child_process';
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
  for (const [id, status] of [[TENANT_A, 'active'], [TENANT_B, 'active'], [TENANT_SUSPENDED, 'suspended']]) {
    await admin.query(`INSERT INTO tenants (id, display_name, status, created_by, changed_by) VALUES ($1, $1, $2, 'worker-test', 'worker-test')`, [id, status]);
  }
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
    const { rows } = await client.query('SELECT job_id, created FROM job_enqueue($1, $2::jsonb, $3, $4, $5)', [type, JSON.stringify(payload), key, options.runAfter ?? new Date(), options.maxAttempts ?? 3]);
    await client.query('COMMIT');
    return { jobId: rows[0].job_id as string, created: rows[0].created as boolean };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

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
