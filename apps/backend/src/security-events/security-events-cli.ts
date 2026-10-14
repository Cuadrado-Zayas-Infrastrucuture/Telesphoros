import type { Queryable } from '../membership/pg-membership-admin';

export const SECURITY_EVENTS_USAGE = `  security-events list --tenant ID [--since ISO_TIME] [--type EVENT_TYPE] [--limit N]
                                prints the organization's security events, newest first, one JSON object per line (DATABASE_AUDITOR_URL: the
                                auditor login, a member of telesphoros_security_auditor only). Default 50 events, at most 500. Read-only: nothing
                                in the application or this tool can change or delete an event.
`;

export const EVENT_TYPES = [
  'membership.granted', 'membership.reinstated', 'membership.roles-changed', 'membership.removed', 'membership.sessions-revoked', 'access.refused',
] as const;

const MAX_LIMIT = 500;

interface EventRow {
  seq: string;
  occurred_at: Date;
  tenant_id: string | null;
  event_type: string;
  outcome: string;
  actor_kind: string;
  actor_ref: string;
  subject_kind: string;
  subject_ref: string;
  request_id: string | null;
  details: Record<string, unknown>;
  db_user: string;
}

function parse(args: string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i];
    const value = args[i + 1];
    if (!name?.startsWith('--') || value === undefined) throw new Error(`Expected "--name value" pairs, got: ${args.slice(i).join(' ')}`);
    values.set(name.slice(2), value);
  }
  return values;
}

/** Runs one security-events command. Returns the process exit code. Prints only the stored, allowlisted fields. */
export async function runSecurityEvents(client: Queryable, args: string[], out: (line: string) => void): Promise<number> {
  const [action, ...rest] = args;
  try {
    if (action !== 'list') throw new Error(`Unknown security-events command: ${action ?? '(none)'}`);
    const f = parse(rest);
    const tenant = f.get('tenant');
    if (!tenant) throw new Error('--tenant is required');
    const type = f.get('type');
    if (type !== undefined && !(EVENT_TYPES as readonly string[]).includes(type)) throw new Error(`Unknown event type. Known types: ${EVENT_TYPES.join(', ')}.`);
    const since = f.get('since');
    if (since !== undefined && Number.isNaN(Date.parse(since))) throw new Error('--since must be a date and time, for example 2026-10-13T00:00:00Z.');
    const limit = f.has('limit') ? Number(f.get('limit')) : 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new Error(`--limit must be a whole number from 1 to ${MAX_LIMIT}.`);
    const { rows } = await client.query<EventRow>(
      `SELECT seq, occurred_at, tenant_id, event_type, outcome, actor_kind, actor_ref, subject_kind, subject_ref, request_id, details, db_user
         FROM security_events
        WHERE tenant_id = $1 AND ($2::text IS NULL OR event_type = $2) AND ($3::timestamptz IS NULL OR occurred_at >= $3::timestamptz)
        ORDER BY seq DESC LIMIT $4`,
      [tenant, type ?? null, since ?? null, limit],
    );
    for (const r of rows) {
      out(JSON.stringify({
        seq: Number(r.seq), at: r.occurred_at.toISOString(), tenant: r.tenant_id, type: r.event_type, outcome: r.outcome, actor: `${r.actor_kind}:${r.actor_ref}`,
        subject: `${r.subject_kind}:${r.subject_ref}`, requestId: r.request_id, details: r.details, dbUser: r.db_user,
      }));
    }
    out(`${rows.length} event${rows.length === 1 ? '' : 's'}`);
    return 0;
  } catch (error) {
    if (error instanceof Error && (error as { code?: string }).code === undefined) {
      out(`refused: ${error.message}`);
      return 1;
    }
    throw error;
  }
}
