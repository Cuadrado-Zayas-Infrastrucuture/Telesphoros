import type { Pool } from 'pg';
import type { MembershipMirror } from '../../src/auth/mirror-token-verifier';
import { normalizeRoles } from '../../src/membership/membership';

/**
 * Test-only: makes the membership table match a verified token's claims, over the owner connection (the application's own login cannot
 * write the table). Moves a person out of any other organization first, because a person is active in one at a time.
 */
export class PgMembershipMirror implements MembershipMirror {
  constructor(private readonly pool: Pool) {}

  async mirror(tenantId: string, sub: string, roles: readonly string[]): Promise<void> {
    const wanted = normalizeRoles(roles);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Concurrent requests for the same person (two simultaneous uploads) must not race each other's first insert.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`membership-mirror:${sub}`]);
      await client.query(`UPDATE tenant_memberships SET status = 'removed', changed_by = 'test-mirror' WHERE sub = $1 AND tenant_id <> $2 AND status = 'active'`, [sub, tenantId]);
      await client.query(
        `INSERT INTO tenant_memberships AS m (tenant_id, sub, status, roles, changed_by) VALUES ($1, $2, 'active', $3::text[], 'test-mirror')
         ON CONFLICT (tenant_id, sub) DO UPDATE SET status = 'active', roles = EXCLUDED.roles, changed_by = 'test-mirror'
          WHERE m.status <> 'active' OR m.roles <> EXCLUDED.roles`,
        [tenantId, sub, wanted],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
