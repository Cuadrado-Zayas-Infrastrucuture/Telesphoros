import type { Client } from 'pg';

export const CONNECTION_LIMITS_USAGE = `  connection-limits             the server's connection limit, the slots it reserves, each login's own limit, and the db_connection_budget they
                                imply (read-only; DATABASE_MIGRATOR_URL). Run it once on a new instance and set db_connection_budget in Terraform
                                from it (infrastructure/terraform/database-connections.tf). Prints settings and role names only, never a connection string.
`;

export interface ConnectionLimits {
  maxConnections: number;
  superuserReserved: number;
  /** reserved_connections (PostgreSQL 16 and later): slots for roles granted pg_use_reserved_connections. Null on an older server. */
  reserved: number | null;
  /** rds.rds_superuser_reserved_connections: slots RDS keeps for its own administrator, where the instance has the setting. */
  rdsReserved: number | null;
  /** max_connections less every reserved slot: the connections the application's logins can open together. */
  budget: number;
  /** Every login role and its CONNECTION LIMIT (-1: none of its own). */
  logins: { name: string; limit: number }[];
}

/** max_connections less every slot the server keeps back: the connections the application's logins can open together. */
export function connectionBudget(l: Pick<ConnectionLimits, 'maxConnections' | 'superuserReserved' | 'reserved' | 'rdsReserved'>): number {
  return l.maxConnections - l.superuserReserved - (l.reserved ?? 0) - (l.rdsReserved ?? 0);
}

function whole(name: string, value: string | null): number | null {
  if (value === null || value === '') return null;
  if (!/^\d+$/.test(value)) throw new Error(`${name} is not a whole number`);
  return Number(value);
}

/** Reads the limits in one statement each, on any login: these settings and pg_roles are readable by every role. */
export async function readConnectionLimits(client: Client): Promise<ConnectionLimits> {
  const settings = await client.query<{ max: string; superuser: string; reserved: string | null; rds: string | null }>(
    `SELECT current_setting('max_connections') AS max,
            current_setting('superuser_reserved_connections') AS superuser,
            current_setting('reserved_connections', true) AS reserved,
            current_setting('rds.rds_superuser_reserved_connections', true) AS rds`,
  );
  const row = settings.rows[0]!;
  const maxConnections = whole('max_connections', row.max)!;
  const superuserReserved = whole('superuser_reserved_connections', row.superuser)!;
  const reserved = whole('reserved_connections', row.reserved);
  const rdsReserved = whole('rds.rds_superuser_reserved_connections', row.rds);
  const roles = await client.query<{ rolname: string; rolconnlimit: number }>('SELECT rolname, rolconnlimit FROM pg_roles WHERE rolcanlogin ORDER BY rolname');
  return {
    maxConnections,
    superuserReserved,
    reserved,
    rdsReserved,
    budget: connectionBudget({ maxConnections, superuserReserved, reserved, rdsReserved }),
    logins: roles.rows.map((r) => ({ name: r.rolname, limit: r.rolconnlimit })),
  };
}

/** `connection-limits`. Read-only. Returns the exit code. */
export async function runConnectionLimits(client: Client, args: string[], out: (line: string) => void): Promise<number> {
  if (args.length > 0) {
    out(CONNECTION_LIMITS_USAGE);
    return 2;
  }
  const limits = await readConnectionLimits(client);
  const shown = (value: number | null) => (value === null ? 'not set' : String(value));
  out(`max_connections: ${limits.maxConnections}`);
  out(`superuser_reserved_connections: ${limits.superuserReserved}`);
  out(`reserved_connections: ${shown(limits.reserved)}`);
  out(`rds.rds_superuser_reserved_connections: ${shown(limits.rdsReserved)}`);
  out(`budget (max_connections less the reserved slots): ${limits.budget}`);
  out('login connection limits (-1: no limit of its own):');
  const width = Math.max(0, ...limits.logins.map((l) => l.name.length));
  for (const l of limits.logins) out(`  ${l.name.padEnd(width)} ${l.limit}`);
  out(`Set in Terraform from this reading: db_connection_budget = ${limits.budget}`);
  return 0;
}
