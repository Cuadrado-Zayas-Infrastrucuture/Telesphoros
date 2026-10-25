import { tenantIdSchema } from '@telesphoros/shared-types';
import type { PoolClient } from 'pg';
import { AppException } from '../common/app-exception';
import { MAX_BROWSER_SESSION_MS } from './browser-session';

/** Trusted immutable custody metadata, never a cookie, access token or authorization decision. */
export interface BrowserSessionAuthority {
  readonly tenantId: string;
  readonly handleHash: string;
  readonly issuedAt: number;
  /** Epoch milliseconds, matching custody's immutable timestamps exactly. */
  readonly createdAt: number;
  readonly expiresAt: number;
}

/** A present but malformed binding must never turn into membership-only admission. */
export function assertSessionAuthority(value: unknown): asserts value is BrowserSessionAuthority {
  if (!value || typeof value !== 'object') throw AppException.unauthorized();
  const s = value as BrowserSessionAuthority;
  if (
    !tenantIdSchema.safeParse(s.tenantId).success ||
    typeof s.handleHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(s.handleHash) ||
    !Number.isSafeInteger(s.issuedAt) ||
    s.issuedAt < 0 ||
    !Number.isSafeInteger(s.createdAt) ||
    !Number.isFinite(new Date(s.createdAt).getTime()) ||
    !Number.isSafeInteger(s.expiresAt) ||
    !Number.isFinite(new Date(s.expiresAt).getTime()) ||
    s.expiresAt <= s.createdAt ||
    s.expiresAt - s.createdAt > MAX_BROWSER_SESSION_MS
  )
    throw AppException.unauthorized();
}

/**
 * Final session admission on the protected write's OWN client, after its membership lock.
 * The materialized lock is acquired before checking expiry, including after a lock wait.
 * The caller keeps this transaction open through COMMIT; a separate custody read cannot substitute.
 */
export async function assertSessionCurrent(client: PoolClient, tenantId: string, sub: string, session: BrowserSessionAuthority): Promise<void> {
  assertSessionAuthority(session);
  if (session.tenantId !== tenantId) throw AppException.unauthorized();
  let active: boolean;
  try {
    const result = await client.query<{ active: boolean }>(
      `WITH locked_session AS MATERIALIZED (
      SELECT sub, issued_at, created_at, expires_at, revoked_at FROM browser_sessions
      WHERE tenant_id = $1 AND handle_hash = $2 FOR SHARE
    ) SELECT true AS active FROM locked_session
      WHERE sub = $3 AND issued_at = $4 AND created_at = $5::timestamptz AND expires_at = $6::timestamptz
        AND revoked_at IS NULL AND expires_at > clock_timestamp()`,
      [tenantId, session.handleHash, sub, session.issuedAt, new Date(session.createdAt).toISOString(), new Date(session.expiresAt).toISOString()],
    );
    active = result.rows[0]?.active === true;
  } catch {
    // Timeouts, deadlocks and missing authority infrastructure are unavailable, never allow or token-expiry guesses.
    throw AppException.unavailable('Access checks are unavailable.');
  }
  if (!active) throw AppException.unauthorized();
}
