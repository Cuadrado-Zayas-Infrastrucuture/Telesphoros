import { Logger } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import { capabilityAbsentReason, currentRequestAuthority, currentRequestCapability } from '../auth/authority-context';
import { assertSessionCurrent } from '../auth/session-admission';
import { AppException } from '../common/app-exception';
import { CapabilityCounter, type CapabilityStats } from './capability-counter';
import { migrationReadiness, pendingMigrations, type MigrationReadiness } from './migrator';
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

/** One row for `security_event_append`: identifiers and short codes only. */
export interface SecurityEventInput {
  eventType: string;
  outcome: string;
  subjectKind: string;
  subjectRef: string;
  details: Record<string, string>;
  requestId?: string;
}

export interface TenantWorkOptions {
  /**
   * The authenticated individual (the token's `sub`). Recorded as the author of audited writes. Like the tenant, it is an identity
   * CLAIM supplied by authenticated application code, never taken from a request body, and transaction-local.
   */
  actor?: string;
  /**
   * Only for the sign-out write (AUTH-03): member_sign_out() changes the caller's OWN membership row, so the version this request was admitted with
   * moves by design and the post-work recheck would refuse the very write that ends the session. The function touches only an ACTIVE row, so a
   * removal that lands in the meantime makes it a no-op, not a bypass. Admission before the work is unchanged.
   */
  ownVersionMayChange?: boolean;
}

/**
 * The application's only door to PostgreSQL.
 *
 * `withTenant` runs a unit of work inside ONE transaction that first sets `app.current_tenant_id`
 * (transaction-local, so it cannot leak to the next request on a pooled connection). The row-level
 * security policies read that setting: if it is missing, the application role sees no rows.
 *
 * It also sets `app.capability` (DATA-01), the request's issuer-minted proof, on every call and likewise transaction-locally. Nothing reads it yet: the
 * binding mode is `guc`, so a transaction without one runs exactly as before and is counted (`capabilityStats`).
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
  private readonly capabilities = new CapabilityCounter();

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
    // The class and code only: a driver message can carry the host or the user name (audit finding INF-10).
    this.pool.on('error', (error) => this.logger.error({ event: 'database-idle-client-error', error }, 'Idle database client error'));
  }

  async withTenant<T>(tenantId: string, work: (client: PoolClient) => Promise<T>, options: TenantWorkOptions = {}): Promise<T> {
    if (!tenantId || tenantId.length > MAX_TENANT_ID_LENGTH) throw new Error('Invalid tenant id');
    const { actor } = options;
    if (actor !== undefined && (!actor || actor.length > MAX_ACTOR_LENGTH || CONTROL_CHARACTERS.test(actor))) throw new Error('Invalid actor');
    // A request that outlived its capability is refused, never run: the database would resolve no organization, and row-level security answers that with
    // no rows rather than an error, so a slow read would look empty (audit A3). The caller retries as a new request, which is issued a new capability.
    const capability = currentRequestCapability();
    if (capability && capability.expiresAt.getTime() <= Date.now()) {
      this.capabilities.recordMissing('expired');
      throw AppException.unavailable('This request took too long. Try again.');
    }
    const client = await this.pool.connect().catch((error) => {
      if (currentRequestAuthority()?.session) throw AppException.unavailable('Access checks are unavailable.');
      // Pool full past the 2 s limit, or the database not answering: busy, not a fault in the request. The driver's message can carry the host.
      this.logger.warn({ event: 'database-connection-unavailable', code: (error as { code?: unknown })?.code }, 'No database connection could be had.');
      throw AppException.databaseBusy();
    });
    let discard = false;
    let refused: ReturnType<typeof currentRequestAuthority>;
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
      if (actor !== undefined) await client.query(`SELECT set_config('app.current_actor', $1, true)`, [actor]);
      await this.bindCapability(client);
      const result = await work(client);
      if (!options.ownVersionMayChange && !(await this.authorityStillCurrent(client, tenantId))) {
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

  /**
   * The request's capability, if it has one, goes in after BEGIN with is_local = true, so the next transaction on this pooled connection cannot see it.
   * One that expired before the transaction was refused above (except for `appendSecurityEvent`, which binds it on purpose); one that expires in between is still set (the database then resolves nothing) and counted as missing. EVERY call is counted, the guard's own
   * membership lookup included: it runs under the capability, which the guard now asks for first.
   */
  private async bindCapability(client: PoolClient): Promise<void> {
    const capability = currentRequestCapability();
    if (capability) await client.query(`SELECT set_config('app.capability', $1, true)`, [capability.token]);
    if (capability && capability.expiresAt.getTime() > Date.now()) this.capabilities.recordBound();
    else this.capabilities.recordMissing(capability ? 'expired' : (capabilityAbsentReason() ?? 'absent'));
  }

  /** Transactions with and without a capability since this process started, with the reason for each miss. */
  capabilityStats(): CapabilityStats {
    return this.capabilities.snapshot();
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

  /**
   * Records one refusal through `security_event_append`, and runs nothing else (spec 015). Unlike `withTenant` it does not refuse a request that outlived
   * its capability: the capability is bound even when expired, and the database's event writer accepts it for a grace window (migration 0058) while
   * every other function and policy still sees no organization. The organization and person are set as settings too, which the guc and dual modes
   * read when there is no capability. Errors propagate; the caller logs them.
   */
  async appendSecurityEvent(tenantId: string, actor: string, event: SecurityEventInput): Promise<void> {
    if (!tenantId || tenantId.length > MAX_TENANT_ID_LENGTH) throw new Error('Invalid tenant id');
    if (!actor || actor.length > MAX_ACTOR_LENGTH || CONTROL_CHARACTERS.test(actor)) throw new Error('Invalid actor');
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true), set_config('app.current_actor', $2, true)`, [tenantId, actor]);
      await this.bindCapability(client);
      await client.query('SELECT security_event_append($1, $2, $3, $4, $5::jsonb, $6)', [
        event.eventType,
        event.outcome,
        event.subjectKind,
        event.subjectRef,
        JSON.stringify(event.details),
        event.requestId ?? null,
      ]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {
        discard = true; // the connection is already broken; release(true) below throws it away
      });
      throw error;
    } finally {
      client.release(discard);
    }
  }

  /** The app role has EXECUTE on this writer, but no table privileges. */
  async recordSecurityEvent(event: SecurityAuditEvent): Promise<void> {
    await this.pool.query('SELECT public.security_audit_record($1,$2,$3,$4,$5,$6,$7)', [
      event.type,
      event.outcome,
      event.tenantId,
      event.actorSub,
      event.routeKey,
      event.subjectId,
      event.requestId,
    ]);
  }

  /** Pending versions after strict history validation; invalid or newer recorded history throws. */
  pendingMigrations(): Promise<string[]> {
    return pendingMigrations(this.pool);
  }

  /** Pending versions, plus newer applied versions this code tolerates because they are all declared `expand`. Used by /ready only. */
  migrationReadiness(): Promise<MigrationReadiness> {
    return migrationReadiness(this.pool);
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
