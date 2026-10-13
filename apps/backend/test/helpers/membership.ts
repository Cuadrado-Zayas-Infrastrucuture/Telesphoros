import type { Pool } from 'pg';
import { PgMembershipAdmin, type Queryable } from '../../src/membership/pg-membership-admin';
import { PgTenantAdmin } from '../../src/membership/pg-tenant-admin';
import type { MembershipMirror } from '../../src/auth/mirror-token-verifier';
import { type MembershipAdmin, type MembershipChange, type MembershipGrant, normalizeRoles, type TenantAdmin } from '../../src/membership/membership';

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
      await client.query(`INSERT INTO tenants (id, display_name, created_by, changed_by) VALUES ($1, $1, 'test-mirror', 'test-mirror') ON CONFLICT (id) DO NOTHING`, [tenantId]);
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

/** The operator handle for tests: registers an organization the first time someone is granted into it, so tests need not register each one by hand. */
export class RegisteringMembershipAdmin implements MembershipAdmin {
  constructor(
    private readonly inner: MembershipAdmin,
    private readonly tenants: TenantAdmin,
  ) {}

  private async ensure(tenantId: string): Promise<void> {
    if (!(await this.tenants.listTenants()).some((t) => t.id === tenantId)) {
      await this.tenants.registerTenant({ id: tenantId, displayName: tenantId, by: 'test-helper' }).catch(() => undefined);
    }
  }

  async grant(input: MembershipGrant) {
    await this.ensure(input.tenantId);
    return this.inner.grant(input);
  }

  setRoles(input: MembershipGrant) {
    return this.inner.setRoles(input);
  }

  remove(input: MembershipChange) {
    return this.inner.remove(input);
  }

  revokeSessions(input: MembershipChange) {
    return this.inner.revokeSessions(input);
  }

  show(tenantId: string, sub: string) {
    return this.inner.show(tenantId, sub);
  }
}

/** The operator handle over any connection that owns the tables, registering an organization the first time someone is granted into it. */
export const registeringAdmin = (db: Queryable): MembershipAdmin => new RegisteringMembershipAdmin(new PgMembershipAdmin(db), new PgTenantAdmin(db));

/** Registers an organization over an owner connection, for tests that insert membership rows by hand. Safe to repeat. */
export const registerTenantRow = (db: Queryable, id: string) =>
  db.query(`INSERT INTO tenants (id, display_name, created_by, changed_by) VALUES ($1, $1, 'test-helper', 'test-helper') ON CONFLICT (id) DO NOTHING`, [id]);
