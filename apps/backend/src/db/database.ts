import { Logger } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import { currentRequestAuthority } from '../auth/authority-context';
import { assertSessionCurrent } from '../auth/session-admission';
import { AppException } from '../common/app-exception';
import { pendingMigrations } from './migrator';
import { pgClientConfig } from './tls';
import type { SecurityAuditEvent } from '../auth/security-audit';

export interface DatabaseOptions {
  /** Shown in pg_stat_activity. Tests give each pool its own, to tell which connection is waiting. */
  applicationName?: string;
  /** Connection string for the APPLICATION role (never the migrator/owner). */
  url: string;
  ssl: 'disable' | 'require';
  max?: number;
}

const MAX_TENANT_ID_LENGTH = 128;
const MAX_ACTOR_LENGTH = 128;
// eslint-disable-next-line no-control-regex -- the point is to refuse control characters
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export interface TenantWorkOptions {
  /**
   * The authenticated individual (the token's `sub`). Recorded as the author of audited writes. Like the tenant, it is an identity
   * CLAIM supplied by authenticated application code, never taken from a request body, and transaction-local.
   */
  actor?: string;
}

/**
 * The application's only door to PostgreSQL.
 *
 * `withTenant` runs a unit of work inside ONE transaction that first sets `app.current_tenant_id`
 * (transaction-local, so it cannot leak to the next request on a pooled connection). The row-level
 * security policies read that setting: if it is missing, the application role sees no rows.
 *
 * Commit boundary for people (docs/auth.md): when the work runs for a request, and the transaction WROTE anything, the caller's membership
 * row is locked SHARED and compared with the version the request was admitted under just before COMMIT. A removal or role change waits for
 * that lock, so a write either commits before the change commits or is rolled back; none commits after it. Read-only transactions skip
 * the lock. Work with no request behind it (background and organization-owned processing) is not tied to a person and is not checked.
 * If trusted internal code binds a browser session, a second shared lock checks that immutable session's subject, revocation and
 * database-time expiry on this same client after the membership check. Both locks are held through commit. No cookie path binds one yet.
 */
export class Database {
  private readonly logger = new Logger('Database');
  /**
   * Called (best effort, after the rollback) when a request's write was refused because its caller's membership changed under it.
   * The security-event recorder sets it; it is not part of the constructor so the database layer needs no knowledge of it.
   */
  onAuthorityRefused?: (tenantId: string, sub: string) => Promise<void>;
  private readonly pool: Pool;

  constructor(options: DatabaseOptions) {
    this.pool = new Pool({
      ...pgClientConfig(options.url, options.ssl), // TLS comes from the explicit setting only; a URL that carries TLS parameters is refused
      max: options.max ?? 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 2_000, // fail fast instead of queueing forever when the database is down
      statement_timeout: 5_000, // no query may run unbounded
      idle_in_transaction_session_timeout: 10_000,
      application_name: options.applicationName ?? 'telesphoros-backend',
    });
    // An idle client can die (failover, restart). Without a listener that becomes a process crash.
    this.pool.on('error', (error) => this.logger.error(`Idle database client error: ${error.message}`));
  }

  async withTenant<T>(tenantId: string, work: (client: PoolClient) => Promise<T>, options: TenantWorkOptions = {}): Promise<T> {
    if (!tenantId || tenantId.length > MAX_TENANT_ID_LENGTH) throw new Error('Invalid tenant id');
    const { actor } = options;
    if (actor !== undefined && (!actor || actor.length > MAX_ACTOR_LENGTH || CONTROL_CHARACTERS.test(actor))) throw new Error('Invalid actor');
    const client = await this.pool.connect().catch(error => {
      if (currentRequestAuthority()?.session) throw AppException.unavailable('Access checks are unavailable.');
      throw error;
    });
    let discard = false;
    let refused: ReturnType<typeof currentRequestAuthority>;
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
      if (actor !== undefined) await client.query(`SELECT set_config('app.current_actor', $1, true)`, [actor]);
      const result = await work(client);
      if (!(await this.authorityStillCurrent(client, tenantId))) {
        refused = currentRequestAuthority();
        throw AppException.forbidden();
      }
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // intentional: the connection is already broken; release(true) below throws it away
        discard = true;
      }
      if (refused && this.onAuthorityRefused) await this.onAuthorityRefused(tenantId, refused.sub).catch(() => undefined);
      throw error;
    } finally {
      client.release(discard);
    }
  }

  /** False for changed membership; throws 401/503 for refused/unavailable session admission. Reads keep admission-time semantics. */
  private async authorityStillCurrent(client: PoolClient, tenantId: string): Promise<boolean> {
    const authority = currentRequestAuthority();
    if (!authority) return true;
    let memberCurrent: boolean;
    try {
      // An id is assigned at the first write (including a row lock), never to a read.
      const wrote = await client.query<{ wrote: boolean }>('SELECT txid_current_if_assigned() IS NOT NULL AS wrote');
      if (!wrote.rows[0]!.wrote) return true;
      const current = await client.query<{ ok: boolean }>('SELECT membership_assert_current($1, $2) AS ok', [authority.sub, authority.version]);
      memberCurrent = current.rows[0]?.ok === true;
    } catch (error) {
      if (authority.session) throw AppException.unavailable('Access checks are unavailable.');
      throw error;
    }
    if (!memberCurrent) return false;
    // Membership then session, on this client. Both shared locks survive until COMMIT/ROLLBACK.
    if (authority.session) await assertSessionCurrent(client, tenantId, authority.sub, authority.session);
    return true;
  }

  /** Cheap liveness probe for /ready. */
  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  /** The app role has EXECUTE on this writer, but no table privileges. */
  async recordSecurityEvent(event: SecurityAuditEvent): Promise<void> {
    await this.pool.query('SELECT public.security_audit_record($1,$2,$3,$4,$5,$6,$7)', [
      event.type, event.outcome, event.tenantId, event.actorSub, event.routeKey, event.subjectId, event.requestId,
    ]);
  }

  /** Pending versions after strict history validation; invalid or newer recorded history throws. */
  pendingMigrations(): Promise<string[]> {
    return pendingMigrations(this.pool);
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
