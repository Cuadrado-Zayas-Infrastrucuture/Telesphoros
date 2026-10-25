import type { PoolClient } from 'pg';
import { tenantIdSchema } from '@telesphoros/shared-types';
import type { Database } from '../../db/database';
import { BrowserSessionRepository, type BrowserSessionRecord, SessionCustodyError } from '../browser-session.repository';

interface SessionRow {
  tenant_id: string;
  handle_hash: string;
  sub: string;
  issued_at: string;
  created_at: Date;
  expires_at: Date;
  credential: string;
}
const HASH = /^[0-9a-f]{64}$/;
const fields = 'tenant_id, handle_hash, sub, issued_at, created_at, expires_at, credential';
const record = (row: SessionRow): BrowserSessionRecord => ({
  tenantId: row.tenant_id,
  handleHash: row.handle_hash,
  sub: row.sub,
  issuedAt: Number(row.issued_at),
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  credential: row.credential,
});

/** Not registered in StorageModule: no cookie/session request is admitted by this slice. */
export class PostgresBrowserSessionRepository extends BrowserSessionRepository {
  constructor(private readonly database: Database) {
    super();
  }

  private async tenant<T>(tenantId: string, work: (client: PoolClient) => Promise<T>, hash?: string): Promise<T> {
    if (!tenantIdSchema.safeParse(tenantId).success || (hash !== undefined && !HASH.test(hash))) throw new SessionCustodyError('invalid');
    try {
      return await this.database.withTenant(tenantId, work);
    } catch {
      throw new SessionCustodyError('unavailable');
    }
  }

  async insert(row: BrowserSessionRecord): Promise<void> {
    await this.tenant(
      row.tenantId,
      async (client) => {
        await client.query(`INSERT INTO browser_sessions (${fields}) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [
          row.tenantId,
          row.handleHash,
          row.sub,
          row.issuedAt,
          row.createdAt,
          row.expiresAt,
          row.credential,
        ]);
      },
      row.handleHash,
    );
  }

  async findActive(tenantId: string, handleHash: string): Promise<BrowserSessionRecord | undefined> {
    return this.tenant(
      tenantId,
      async (client) => {
        // The share lock orders this snapshot against revocation. It ends with this transaction;
        // callers MUST NOT treat the returned snapshot as later protected-write admission.
        // Materialization keeps the final database-clock expiry check AFTER the row lock:
        // the early predicate alone can pass before a wait that outlasts the session.
        const { rows } = await client.query<SessionRow>(
          `WITH locked_session AS MATERIALIZED (
        SELECT ${fields} FROM browser_sessions
        WHERE tenant_id = $1 AND handle_hash = $2 AND revoked_at IS NULL AND expires_at > clock_timestamp() FOR SHARE
      ) SELECT ${fields} FROM locked_session WHERE expires_at > clock_timestamp()`,
          [tenantId, handleHash],
        );
        return rows[0] ? record(rows[0]) : undefined;
      },
      handleHash,
    );
  }

  async revoke(tenantId: string, handleHash: string): Promise<boolean> {
    return this.tenant(
      tenantId,
      async (client) => {
        const result = await client.query(
          `UPDATE browser_sessions SET revoked_at = clock_timestamp()
        WHERE tenant_id = $1 AND handle_hash = $2 AND revoked_at IS NULL RETURNING handle_hash`,
          [tenantId, handleHash],
        );
        return result.rowCount === 1;
      },
      handleHash,
    );
  }

  async cleanupExpired(tenantId: string, limit: number): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new SessionCustodyError('invalid');
    return this.tenant(tenantId, async (client) => {
      const result = await client.query(
        `DELETE FROM browser_sessions AS target USING (
        SELECT tenant_id, handle_hash FROM browser_sessions
        WHERE tenant_id = $1 AND expires_at <= clock_timestamp()
        ORDER BY expires_at, handle_hash LIMIT $2 FOR UPDATE SKIP LOCKED
      ) AS expired WHERE target.tenant_id = $1 AND target.tenant_id = expired.tenant_id AND target.handle_hash = expired.handle_hash`,
        [tenantId, limit],
      );
      return result.rowCount ?? 0;
    });
  }
}
