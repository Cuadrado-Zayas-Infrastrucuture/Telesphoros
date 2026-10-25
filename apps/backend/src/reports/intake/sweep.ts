import type { Client } from 'pg';

export interface SweepResult {
  tenantId: string;
  /** Attempts closed (state `cleaned`) and their reservation returned to the organization's quota. */
  released: number;
  releasedBytes: number;
  /** Of those, attempts that may have written an object. The object is NOT deleted (see below). */
  objectsKept: number;
}

/**
 * The operator's sweep of abandoned intake attempts in one organization (M2.2b). An attempt is abandoned when it was cancelled, or when its lease ran out
 * more than `graceSeconds` ago with no writer holding it, and no report or captured text points at its key. Closing it returns its bytes to the
 * organization's reservation quota, which is what a stuck declaration costs.
 *
 * The sweep deletes no object and no object version. Neither the application nor the operator login may (only the documented break-glass role may), and a
 * stored but never committed file is kept on purpose: it was validated, belongs to the report's own prefix, and the six-year retention floor applies to
 * overwritten versions. The attempt stays on record as `cleaned`, so its key remains a known key and does not block the report's next declaration.
 *
 * Runs the database function `uploads_sweep` (DATABASE_MIGRATOR_URL, acting as the queue's owner role), the same one the scheduled `uploads.sweep` job calls, so the
 * two can never disagree.
 */
export async function sweepTenantUploads(client: Client, tenantId: string, options: { graceSeconds: number; dryRun: boolean }): Promise<SweepResult> {
  if (!Number.isInteger(options.graceSeconds) || options.graceSeconds < 0 || options.graceSeconds > 604800) throw new Error('graceSeconds must be between 0 and 604800.');
  await client.query('BEGIN');
  try {
    // The one implementation is a database function owned by the queue's definer role (migration 0024), which the scheduled job also uses; it binds the organization
    // itself, so row-level security still applies to every statement.
    await client.query('SET LOCAL ROLE telesphoros_jobs');
    const { rows } = await client.query<{ released: number; released_bytes: string; objects_kept: number }>('SELECT * FROM uploads_sweep($1, $2, $3)', [
      tenantId,
      options.graceSeconds,
      options.dryRun,
    ]);
    await client.query(options.dryRun ? 'ROLLBACK' : 'COMMIT');
    return { tenantId, released: Number(rows[0]!.released), releasedBytes: Number(rows[0]!.released_bytes), objectsKept: Number(rows[0]!.objects_kept) };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

export const UPLOADS_USAGE = `  uploads sweep [--tenant ID] [--grace-seconds N] [--dry-run]
                                close abandoned intake attempts and return their reservation (DATABASE_MIGRATOR_URL: the table owner). Abandoned: cancelled,
                                or the lease ended more than N seconds ago (default 86400, at most 604800). Deletes no object (no login may; see
                                docs/ops/break-glass.md) and never touches a committed attempt. --dry-run reports without changing anything.
`;

/** `uploads sweep`: every organization (or one), one line per organization with something to report, then a total. Returns the process exit code. */
export async function runUploads(client: Client, args: string[], out: (line: string) => void): Promise<number> {
  const [sub, ...rest] = args;
  if (sub !== 'sweep') {
    out(UPLOADS_USAGE);
    return 2;
  }
  let tenant: string | undefined;
  let grace = 86400;
  let dryRun = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--dry-run') dryRun = true;
    else if (arg === '--tenant' && rest[i + 1]) tenant = rest[++i];
    else if (arg === '--grace-seconds' && rest[i + 1]) grace = Number(rest[++i]);
    else {
      out(UPLOADS_USAGE);
      return 2;
    }
  }
  if (!Number.isInteger(grace) || grace < 0 || grace > 604800) {
    out('--grace-seconds must be a whole number from 0 to 604800.');
    return 2;
  }
  const tenants = tenant ? [tenant] : (await client.query<{ id: string }>('SELECT id FROM tenants ORDER BY id')).rows.map((r) => r.id);
  let released = 0,
    bytes = 0,
    kept = 0;
  for (const id of tenants) {
    const r = await sweepTenantUploads(client, id, { graceSeconds: grace, dryRun });
    released += r.released;
    bytes += r.releasedBytes;
    kept += r.objectsKept;
    if (r.released) out(`${dryRun ? 'would release' : 'released'}: tenant=${id} attempts=${r.released} bytes=${r.releasedBytes} objects-kept=${r.objectsKept}`);
  }
  out(
    `${dryRun ? 'dry run: nothing changed. ' : ''}${dryRun ? 'would release' : 'released'} ${released} attempt(s), ${bytes} byte(s) of quota, across ${tenants.length} organization(s); ${kept} of them may have left an object in the bucket (never deleted here)`,
  );
  return 0;
}
