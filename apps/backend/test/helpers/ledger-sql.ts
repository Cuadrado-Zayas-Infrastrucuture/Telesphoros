import { randomUUID } from 'node:crypto';
import { Client } from 'pg';

export interface PgError { code?: string; message: string; constraint?: string }

/**
 * Runs `work` as a login (the application role by default) inside one transaction with the tenant and actor settings, then COMMITs.
 * Returns the error raised by `work` or by the COMMIT (deferred constraints fail there), or undefined. Always rolls back on failure.
 */
export async function attempt(url: string, tenantId: string | null, actor: string | null, work: (c: Client) => Promise<unknown>): Promise<PgError | undefined> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    await c.query('BEGIN');
    if (tenantId !== null) await c.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
    if (actor !== null) await c.query(`SELECT set_config('app.current_actor', $1, true)`, [actor]);
    await work(c);
    await c.query('COMMIT');
    return undefined;
  } catch (error) {
    await c.query('ROLLBACK').catch(() => undefined); // intentional: the transaction may already be gone
    return error as PgError;
  } finally {
    await c.end();
  }
}

/** Like `attempt`, but returns what `work` returns and throws on any error. */
export async function run<T>(url: string, tenantId: string | null, actor: string | null, work: (c: Client) => Promise<T>): Promise<T> {
  let out: T | undefined;
  const error = await attempt(url, tenantId, actor, async (c) => {
    out = await work(c);
  });
  if (error) throw Object.assign(new Error(error.message), error);
  return out as T;
}

export const uuid = (): string => randomUUID();
