import type { Client } from 'pg';
import { organizationRunId } from './scope';

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
 * Runs as the table owner (DATABASE_MIGRATOR_URL) with the organization bound for the transaction, so row-level security still applies to every statement.
 */
export async function sweepTenantUploads(client: Client, tenantId: string, options: { graceSeconds: number; dryRun: boolean }): Promise<SweepResult> {
  if (!Number.isInteger(options.graceSeconds) || options.graceSeconds < 0 || options.graceSeconds > 604800) throw new Error('graceSeconds must be between 0 and 604800.');
  const run = organizationRunId(tenantId);
  await client.query('BEGIN');
  try {
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
    const abandoned = await client.query<{ id: string; size_bytes: string; state: string; object_version: string | null }>(
      `SELECT a.id, a.size_bytes, a.state, a.object_version
         FROM report_upload_attempts a
        WHERE a.tenant_id = $1 AND a.run_id = $2 AND a.state NOT IN ('committed', 'cleaned')
          AND (a.state IN ('cancelled', 'cleanup') OR a.lease_until + $3 * interval '1 second' <= now())
          AND (a.writer IS NULL OR a.lease_until + $3 * interval '1 second' <= now())
          AND NOT EXISTS (SELECT 1 FROM reports r WHERE r.tenant_id = a.tenant_id AND r.storage_key = a.storage_key AND r.uploaded_at IS NOT NULL)
          AND NOT EXISTS (SELECT 1 FROM report_captures c WHERE c.tenant_id = a.tenant_id AND c.text_storage_key = a.storage_key)
        ORDER BY a.created_at
        FOR UPDATE`,
      [tenantId, run, options.graceSeconds],
    );
    const result: SweepResult = {
      tenantId,
      released: abandoned.rowCount ?? 0,
      releasedBytes: abandoned.rows.reduce((n, r) => n + Number(r.size_bytes), 0),
      objectsKept: abandoned.rows.filter((r) => r.object_version !== null || r.state === 'stored' || r.state === 'unresolved').length,
    };
    if (!options.dryRun && result.released > 0) {
      await client.query(`UPDATE report_upload_attempts SET state = 'cleaned', writer = NULL, updated_at = now() WHERE tenant_id = $1 AND id = ANY($2::uuid[])`, [tenantId, abandoned.rows.map((r) => r.id)]);
      await client.query('UPDATE report_upload_runs SET reserved_bytes = GREATEST(reserved_bytes - $3, 0), updated_at = now() WHERE tenant_id = $1 AND run_id = $2', [tenantId, run, result.releasedBytes]);
    }
    await client.query(options.dryRun ? 'ROLLBACK' : 'COMMIT');
    return result;
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
  let released = 0, bytes = 0, kept = 0;
  for (const id of tenants) {
    const r = await sweepTenantUploads(client, id, { graceSeconds: grace, dryRun });
    released += r.released; bytes += r.releasedBytes; kept += r.objectsKept;
    if (r.released) out(`${dryRun ? 'would release' : 'released'}: tenant=${id} attempts=${r.released} bytes=${r.releasedBytes} objects-kept=${r.objectsKept}`);
  }
  out(`${dryRun ? 'dry run: nothing changed. ' : ''}${dryRun ? 'would release' : 'released'} ${released} attempt(s), ${bytes} byte(s) of quota, across ${tenants.length} organization(s); ${kept} of them may have left an object in the bucket (never deleted here)`);
  return 0;
}
