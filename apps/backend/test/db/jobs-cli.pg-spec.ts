import { Client } from 'pg';
import { runJobs } from '../../src/jobs/jobs-cli';
import { createEphemeralDatabase, type EphemeralDatabase, withAdmin } from '../helpers/database';
import { registerTenantRow } from '../helpers/membership';

let db: EphemeralDatabase;
beforeAll(async () => {
  db = await createEphemeralDatabase();
  await withAdmin(db.adminUrl, async (c) => {
    await registerTenantRow(c, 'tenant-jobs-a');
    await registerTenantRow(c, 'tenant-jobs-b');
  });
});
afterAll(async () => db?.drop());

const run = (args: string[]) =>
  withAdmin(db.adminUrl, async (c: Client) => {
    const lines: string[] = [];
    const code = await runJobs(c, args, (l) => lines.push(l));
    return { code, text: lines.join('\n') };
  });
const sql = <T extends Record<string, unknown> = Record<string, unknown>>(text: string, values: unknown[] = []) =>
  withAdmin(db.adminUrl, (c) => c.query<T>(text, values).then((r) => r.rows));

async function insertJob(tenant: string, state: string, extra = ''): Promise<string> {
  const finished = ['succeeded', 'dead', 'cancelled'].includes(state);
  const running = state === 'running';
  const rows = await sql<{ id: string }>(
    `INSERT INTO jobs (tenant_id, type, payload, idempotency_key, requested_by, state, attempts, max_attempts, finished_at, lease_until, locked_by, last_error_code)
     VALUES ($1, 'test.echo', '{"n":1}', $2, 'a-person', $3, $4, 3, ${finished ? 'now()' : 'NULL'}, ${running ? `now() + interval '1 minute'` : 'NULL'}, ${running ? `'w1'` : 'NULL'}, ${state === 'dead' ? `'bad-input'` : 'NULL'}) RETURNING id`,
    [tenant, `cli-${Math.random().toString(36).slice(2)}${extra}`, state, state === 'queued' ? 0 : 3],
  );
  return rows[0]!.id;
}

describe('jobs operator command', () => {
  it('reports counts and ages by type and state, and the workers seen', async () => {
    await insertJob('tenant-jobs-a', 'queued');
    await sql(`SELECT job_worker_seen('cli-worker')`);
    const { code, text } = await run(['status']);
    expect(code).toBe(0);
    expect(text).toMatch(/type=test.echo state=queued count=\d+/);
    expect(text).toMatch(/workers: 1 seen in the last 2 minutes, 1 ever/);
  });

  it('lists jobs by organization, state and type, newest first, and only dead ones with "dead"', async () => {
    const a = await insertJob('tenant-jobs-a', 'dead');
    await insertJob('tenant-jobs-b', 'dead');
    await insertJob('tenant-jobs-b', 'succeeded');
    const dead = await run(['dead', '--tenant', 'tenant-jobs-a']);
    expect(dead.code).toBe(0);
    expect(dead.text).toContain(`id=${a} tenant=tenant-jobs-a type=test.echo state=dead attempts=3/3`);
    expect(dead.text).toContain('error=bad-input');
    expect(dead.text).not.toContain('tenant-jobs-b');
    const listed = await run(['list', '--tenant', 'tenant-jobs-b', '--state', 'succeeded']);
    expect(listed.text.match(/state=succeeded/g)).toHaveLength(1);
    expect(listed.text).toContain('1 job(s)');
    expect((await run(['list', '--limit', '1'])).text).toContain('(limited to 1)');
  });

  it('shows one job with its payload (ids and codes only) and its attempt history', async () => {
    const id = await insertJob('tenant-jobs-a', 'dead');
    await sql(`INSERT INTO job_attempts (job_id, tenant_id, attempt, worker_id, outcome, error_code) VALUES ($1, 'tenant-jobs-a', 3, 'w9', 'failed', 'bad-input')`, [id]);
    const { code, text } = await run(['show', '--id', id]);
    expect(code).toBe(0);
    expect(text).toContain('payload={"n":1}');
    expect(text).toContain('attempt=3 outcome=failed error=bad-input worker=w9');
  });

  it('puts one dead job back with fresh attempts and records who did it; a job that is not dead is refused', async () => {
    const dead = await insertJob('tenant-jobs-a', 'dead');
    const { code, text } = await run(['retry', '--id', dead, '--by', 'ops-person']);
    expect(code).toBe(0);
    expect(text).toContain(`requeued: id=${dead}`);
    expect(await sql(`SELECT state, attempts, finished_at, locked_by FROM jobs WHERE id = $1`, [dead])).toEqual([
      { state: 'queued', attempts: 0, finished_at: null, locked_by: null },
    ]);
    expect(await sql(`SELECT attempt, outcome, worker_id FROM job_attempts WHERE job_id = $1`, [dead])).toEqual([
      { attempt: 3, outcome: 'operator-requeued', worker_id: 'operator:ops-person' },
    ]);
    for (const state of ['queued', 'running', 'succeeded', 'cancelled', 'retry']) {
      const id = await insertJob('tenant-jobs-a', state);
      const refused = await run(['retry', '--id', id, '--by', 'ops-person']);
      expect([state, refused.code]).toEqual([state, 1]);
      expect(refused.text).toContain('only a dead job');
      expect((await sql(`SELECT state FROM jobs WHERE id = $1`, [id]))[0]!.state).toBe(state);
    }
    // The requeued job is ready for a worker (claiming is the worker login's job; here the owner only checks the state it would find).
    expect(await sql(`SELECT 1 FROM jobs WHERE id = $1 AND state = 'queued' AND run_after <= now() AND attempts < max_attempts`, [dead])).toHaveLength(1);
  });

  it('cancels a job that has not started and refuses to cancel one that is running, finished or already cancelled', async () => {
    for (const state of ['queued', 'retry']) {
      const id = await insertJob('tenant-jobs-a', state);
      const { code } = await run(['cancel', '--id', id, '--by', 'ops-person']);
      expect([state, code]).toEqual([state, 0]);
      expect(await sql(`SELECT state, finished_at IS NOT NULL AS finished FROM jobs WHERE id = $1`, [id])).toEqual([{ state: 'cancelled', finished: true }]);
      expect((await sql(`SELECT outcome, worker_id FROM job_attempts WHERE job_id = $1`, [id]))[0]).toEqual({ outcome: 'operator-cancelled', worker_id: 'operator:ops-person' });
    }
    for (const state of ['running', 'succeeded', 'dead', 'cancelled']) {
      const id = await insertJob('tenant-jobs-a', state);
      const refused = await run(['cancel', '--id', id, '--by', 'ops-person']);
      expect([state, refused.code]).toEqual([state, 1]);
      expect((await sql(`SELECT state FROM jobs WHERE id = $1`, [id]))[0]!.state).toBe(state);
    }
  });

  it('refuses a malformed id, flag or name, and an unknown job, without changing anything', async () => {
    const id = await insertJob('tenant-jobs-a', 'dead');
    for (const args of [
      ['retry', '--id', 'not-an-id', '--by', 'x'],
      ['retry', '--id', id],
      ['retry', '--id', id, '--by', 'bad\nname'],
      ['show', '--id', '00000000-0000-4000-8000-000000000000'],
      ['list', '--state', 'nonsense'],
      ['list', '--limit', '0'],
      ['list', '--limit', '501'],
    ]) {
      expect([args.join(' '), (await run(args)).code]).toEqual([args.join(' '), 1]);
    }
    for (const args of [[], ['frobnicate'], ['list', '--bogus', 'x'], ['list', '--tenant'], ['status', '--tenant', 'x'], ['retry', '--id', id, '--id', id, '--by', 'x']]) {
      expect([args.join(' '), (await run(args)).code]).toEqual([args.join(' '), 2]);
    }
    expect((await sql(`SELECT state FROM jobs WHERE id = $1`, [id]))[0]!.state).toBe('dead');
  });

  it('works for the real migration login: a login that is not a superuser, holding the queue role by SET only', async () => {
    const login = `jobs_cli_${Math.random().toString(36).slice(2, 8)}`;
    await sql(`CREATE ROLE ${login} LOGIN PASSWORD 'cli-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
    await sql(`GRANT telesphoros_jobs TO ${login} WITH SET TRUE, INHERIT FALSE`);
    const url = new URL(db.adminUrl);
    url.username = login;
    url.password = 'cli-only';
    const client = new Client({ connectionString: url.toString() });
    await client.connect();
    try {
      // Without the command the login can see nothing of the queue...
      await expect(client.query('SELECT count(*) FROM jobs')).rejects.toThrow(/permission denied/);
      // ...and with it, it can read and re-queue, through the queue's own role.
      const id = await insertJob('tenant-jobs-a', 'dead');
      const lines: string[] = [];
      expect(await runJobs(client, ['retry', '--id', id, '--by', 'ops-person'], (l) => lines.push(l))).toBe(0);
      expect(await runJobs(client, ['status'], (l) => lines.push(l))).toBe(0);
      expect(lines.join('\n')).toContain(`requeued: id=${id}`);
      // The session is back to itself afterwards.
      await expect(client.query('SELECT count(*) FROM jobs')).rejects.toThrow(/permission denied/);
    } finally {
      await client.end();
      await sql(`DROP OWNED BY ${login}`);
      await sql(`DROP ROLE ${login}`);
    }
  });

  it('can neither delete nor edit a record: the attempt history stays append-only for the queue owner too', async () => {
    await expect(sql(`DELETE FROM job_attempts`)).rejects.toThrow();
    await expect(sql(`UPDATE job_attempts SET outcome = 'succeeded'`)).rejects.toThrow();
  });
});
