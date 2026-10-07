import { Logger } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import { pendingMigrations } from './migrator';

export interface DatabaseOptions {
  /** Connection string for the APPLICATION role (never the migrator/owner). */
  url: string;
  ssl: 'disable' | 'require';
  max?: number;
}

const MAX_OWNER_ID_LENGTH = 128;

/**
 * The application's only door to PostgreSQL.
 *
 * `withOwner` runs a unit of work inside ONE transaction that first sets `app.current_owner_id`
 * (transaction-local, so it cannot leak to the next request on a pooled connection). The row-level
 * security policies read that setting: if it is missing, the application role sees no rows.
 */
export class Database {
  private readonly logger = new Logger('Database');
  private readonly pool: Pool;

  constructor(options: DatabaseOptions) {
    this.pool = new Pool({
      connectionString: options.url,
      max: options.max ?? 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 2_000, // fail fast instead of queueing forever when the database is down
      statement_timeout: 5_000, // no query may run unbounded
      idle_in_transaction_session_timeout: 10_000,
      application_name: 'telesphoros-backend',
      ssl: options.ssl === 'require' ? { rejectUnauthorized: true } : undefined,
    });
    // An idle client can die (failover, restart). Without a listener that becomes a process crash.
    this.pool.on('error', (error) => this.logger.error(`Idle database client error: ${error.message}`));
  }

  async withOwner<T>(ownerId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    if (!ownerId || ownerId.length > MAX_OWNER_ID_LENGTH) throw new Error('Invalid owner id');
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_owner_id', $1, true)`, [ownerId]);
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

  /** Versions the code ships that the database has not applied yet. */
  pendingMigrations(): Promise<string[]> {
    return pendingMigrations(this.pool);
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
