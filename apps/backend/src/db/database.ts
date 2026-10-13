import { Logger } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
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
 */
export class Database {
  private readonly logger = new Logger('Database');
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
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [tenantId]);
      if (actor !== undefined) await client.query(`SELECT set_config('app.current_actor', $1, true)`, [actor]);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // intentional: the connection is already broken; release(true) below throws it away
        discard = true;
      }
      throw error;
    } finally {
      client.release(discard);
    }
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
