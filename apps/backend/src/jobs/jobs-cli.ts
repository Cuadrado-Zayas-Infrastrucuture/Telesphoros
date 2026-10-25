import type { Client } from 'pg';

export const JOBS_USAGE = `  jobs status
  jobs list [--tenant ID] [--type TYPE] [--state STATE] [--limit N]
  jobs dead [--tenant ID] [--limit N]
  jobs show --id JOB_ID
  jobs retry --id JOB_ID --by NAME
  jobs cancel --id JOB_ID --by NAME
                                the background-job queue (DATABASE_MIGRATOR_URL). Reads counts, states, ages and error CODES; a payload is ids and codes
                                only, and "show" prints it. "retry" puts one dead job back with fresh attempts; "cancel" stops one that has not started
                                (a running job is left to finish or lose its lease). Both are recorded in the job's attempt history under your name.
                                Nothing here ever deletes or edits a record. Run as the queue's owner role, not as the application.
`;

const STATES = ['queued', 'running', 'retry', 'succeeded', 'dead', 'cancelled'];
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// eslint-disable-next-line no-control-regex -- the point is to refuse control characters
const CONTROL = /[\u0000-\u001f\u007f]/;

function parseFlags(args: string[]): Map<string, string> | undefined {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i];
    const value = args[i + 1];
    if (!name?.startsWith('--') || value === undefined || flags.has(name.slice(2))) return undefined;
    flags.set(name.slice(2), value);
  }
  return flags;
}

const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : '-');

/** `jobs ...`. Every statement runs inside one transaction as the queue's owner role (the migrator holds it, without inheriting it). Returns the exit code. */
export async function runJobs(client: Client, args: string[], out: (line: string) => void): Promise<number> {
  const [action, ...rest] = args;
  const flags = parseFlags(rest);
  const usage = () => {
    out(JOBS_USAGE);
    return 2;
  };
  if (!action || !flags) return usage();
  const allowed: Record<string, string[]> = {
    status: [],
    list: ['tenant', 'type', 'state', 'limit'],
    dead: ['tenant', 'limit'],
    show: ['id'],
    retry: ['id', 'by'],
    cancel: ['id', 'by'],
  };
  if (!allowed[action] || [...flags.keys()].some((k) => !allowed[action]!.includes(k))) return usage();
  const refuse = (message: string) => {
    out(`refused: ${message}`);
    return 1;
  };
  const limit = Number(flags.get('limit') ?? 50);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) return refuse('--limit is a whole number from 1 to 500.');
  const state = flags.get('state');
  if (state !== undefined && !STATES.includes(state)) return refuse(`--state is one of ${STATES.join(', ')}.`);
  const id = flags.get('id');
  if ((action === 'show' || action === 'retry' || action === 'cancel') && (!id || !ID.test(id))) return refuse('--id is a job id.');
  const by = flags.get('by');
  if ((action === 'retry' || action === 'cancel') && (!by || by.length > 100 || CONTROL.test(by))) return refuse('--by is 1 to 100 characters without control characters.');

  await client.query('BEGIN');
  try {
    await client.query('SET LOCAL ROLE telesphoros_jobs');
    if (action === 'status') {
      const { rows } = await client.query(`SELECT * FROM job_stats() ORDER BY type, state`);
      for (const r of rows)
        out(`type=${r.type} state=${r.state} count=${r.n}${r.oldest_ready_seconds === null ? '' : ` oldest-ready-seconds=${Math.round(Number(r.oldest_ready_seconds))}`}`);
      const workers = await client.query(`SELECT count(*) FILTER (WHERE last_seen > now() - interval '2 minutes')::int AS live, count(*)::int AS known FROM job_workers`);
      out(`workers: ${workers.rows[0].live} seen in the last 2 minutes, ${workers.rows[0].known} ever`);
    } else if (action === 'list' || action === 'dead') {
      const values: unknown[] = [];
      const where: string[] = [];
      if (action === 'dead') where.push(`state = 'dead'`);
      else if (state) where.push(`state = $${values.push(state)}`);
      if (flags.get('type')) where.push(`type = $${values.push(flags.get('type'))}`);
      if (flags.get('tenant')) where.push(`tenant_id = $${values.push(flags.get('tenant'))}`);
      const { rows } = await client.query(
        `SELECT id, tenant_id, type, state, attempts, max_attempts, run_after, last_error_code, requested_by FROM jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY seq DESC LIMIT ${limit}`,
        values,
      );
      for (const r of rows)
        out(
          `id=${r.id} tenant=${r.tenant_id} type=${r.type} state=${r.state} attempts=${r.attempts}/${r.max_attempts} run-after=${iso(r.run_after)} error=${r.last_error_code ?? '-'} requested-by=${r.requested_by}`,
        );
      out(`${rows.length} job(s)${rows.length === limit ? ` (limited to ${limit})` : ''}`);
    } else if (action === 'show') {
      const job = (await client.query(`SELECT * FROM jobs WHERE id = $1`, [id])).rows[0];
      if (!job) {
        await client.query('ROLLBACK');
        return refuse('no such job.');
      }
      out(`id=${job.id} tenant=${job.tenant_id} type=${job.type} state=${job.state} attempts=${job.attempts}/${job.max_attempts}`);
      out(`payload=${JSON.stringify(job.payload)} key=${job.idempotency_key} requested-by=${job.requested_by}`);
      out(
        `created=${iso(job.created_at)} run-after=${iso(job.run_after)} started=${iso(job.started_at)} lease-until=${iso(job.lease_until)} locked-by=${job.locked_by ?? '-'} finished=${iso(job.finished_at)} error=${job.last_error_code ?? '-'}`,
      );
      const attempts = (await client.query(`SELECT attempt, outcome, error_code, worker_id, started_at, finished_at FROM job_attempts WHERE job_id = $1 ORDER BY seq`, [id])).rows;
      for (const a of attempts)
        out(`  attempt=${a.attempt} outcome=${a.outcome} error=${a.error_code ?? '-'} worker=${a.worker_id} started=${iso(a.started_at)} finished=${iso(a.finished_at)}`);
    } else if (action === 'retry') {
      const dead = (await client.query(`SELECT tenant_id, attempts, started_at FROM jobs WHERE id = $1 AND state = 'dead' FOR UPDATE`, [id])).rows[0];
      if (!dead) {
        await client.query('ROLLBACK');
        return refuse('only a dead job can be retried (see "jobs show").');
      }
      await client.query(
        `UPDATE jobs SET state = 'queued', attempts = 0, run_after = now(), finished_at = NULL, lease_until = NULL, locked_by = NULL, updated_at = now() WHERE id = $1`,
        [id],
      );
      await client.query(`INSERT INTO job_attempts (job_id, tenant_id, attempt, worker_id, started_at, outcome) VALUES ($1, $2, $3, $4, $5, 'operator-requeued')`, [
        id,
        dead.tenant_id,
        dead.attempts,
        `operator:${by}`,
        dead.started_at,
      ]);
      out(`requeued: id=${id} tenant=${dead.tenant_id}`);
    } else {
      const { rows } = await client.query(
        `UPDATE jobs SET state = 'cancelled', finished_at = now(), updated_at = now() WHERE id = $1 AND state IN ('queued', 'retry') RETURNING tenant_id, attempts`,
        [id],
      );
      if (!rows[0]) {
        await client.query('ROLLBACK');
        return refuse('only a job that has not started (queued or waiting to retry) can be cancelled.');
      }
      await client.query(`INSERT INTO job_attempts (job_id, tenant_id, attempt, worker_id, outcome) VALUES ($1, $2, $3, $4, 'operator-cancelled')`, [
        id,
        rows[0].tenant_id,
        rows[0].attempts,
        `operator:${by}`,
      ]);
      out(`cancelled: id=${id} tenant=${rows[0].tenant_id}`);
    }
    await client.query('COMMIT');
    return 0;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}
