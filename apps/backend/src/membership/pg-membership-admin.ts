import type { Role } from '@telesphoros/shared-types';
import {
  checkChange,
  type MembershipAdmin,
  MembershipAdminError,
  type MembershipChange,
  type MembershipGrant,
  type MembershipRecord,
  normalizeRoles,
} from './membership';

/** Anything with a pg-style `query`: a Client or a PoolClient. */
export interface Queryable {
  query<R = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
}

export interface MembershipRow {
  tenant_id: string;
  sub: string;
  status: 'active' | 'removed';
  roles: string[];
  tokens_valid_after_s: string | number;
  version: string | number;
}

/** The columns every query returns, in the shape toMembershipRecord expects. */
export const MEMBERSHIP_COLUMNS = `tenant_id, sub, status, roles, floor(extract(epoch FROM tokens_valid_after))::bigint AS tokens_valid_after_s, version`;

export const toMembershipRecord = (row: MembershipRow): MembershipRecord => ({
  tenantId: row.tenant_id,
  sub: row.sub,
  status: row.status,
  roles: row.roles as Role[],
  tokensValidAfter: Number(row.tokens_valid_after_s),
  version: Number(row.version),
});

const ONE_ACTIVE_PER_PERSON = 'tenant_memberships_one_active_uq';

/**
 * The membership writes, over a connection that owns the table (the migration login the operator command uses; a superuser in tests).
 * The application's own login can only read the table, so nothing in the running API can reach any of this.
 * Each change is one statement, so it is atomic, and the table's trigger bumps the version.
 */
export class PgMembershipAdmin implements MembershipAdmin {
  constructor(private readonly db: Queryable) {}

  async grant(input: MembershipGrant): Promise<MembershipRecord> {
    checkChange(input);
    const roles = normalizeRoles(input.roles);
    try {
      // New person: inserted active. Previously removed: reinstated, and every token issued before this moment stays refused. Already active: no row.
      const { rows } = await this.db.query<MembershipRow>(
        `INSERT INTO tenant_memberships AS m (tenant_id, sub, status, roles, changed_by, reason)
         VALUES ($1, $2, 'active', $3::text[], $4, $5)
         ON CONFLICT (tenant_id, sub) DO UPDATE
            SET status = 'active', roles = EXCLUDED.roles, changed_by = EXCLUDED.changed_by, reason = EXCLUDED.reason,
                tokens_valid_after = GREATEST(m.tokens_valid_after, COALESCE($6::timestamptz, now()))
          WHERE m.status = 'removed'
         RETURNING ${MEMBERSHIP_COLUMNS}`,
        [input.tenantId, input.sub, roles, input.by, input.reason ?? '', input.revokedAt ?? null],
      );
      if (!rows[0]) throw new MembershipAdminError('already-active', 'That person is already an active member of this organization. Use set-roles to change their roles.');
      return toMembershipRecord(rows[0]);
    } catch (error) {
      if ((error as { code?: string; constraint?: string }).code === '23505' && (error as { constraint?: string }).constraint === ONE_ACTIVE_PER_PERSON) {
        throw new MembershipAdminError('in-another-organization', 'That person is an active member of another organization. Remove them there first.');
      }
      throw error;
    }
  }

  async setRoles(input: MembershipGrant): Promise<MembershipRecord> {
    checkChange(input);
    const roles = normalizeRoles(input.roles);
    const { rows } = await this.db.query<MembershipRow>(
      `UPDATE tenant_memberships SET roles = $3::text[], changed_by = $4, reason = $5
        WHERE tenant_id = $1 AND sub = $2 AND status = 'active'
        RETURNING ${MEMBERSHIP_COLUMNS}`,
      [input.tenantId, input.sub, roles, input.by, input.reason ?? ''],
    );
    return this.requireActive(rows[0]);
  }

  async remove(input: MembershipChange): Promise<MembershipRecord> {
    checkChange(input);
    const { rows } = await this.db.query<MembershipRow>(
      `UPDATE tenant_memberships
          SET status = 'removed', changed_by = $3, reason = $4,
              tokens_valid_after = GREATEST(tokens_valid_after, COALESCE($5::timestamptz, now()))
        WHERE tenant_id = $1 AND sub = $2 AND status = 'active'
        RETURNING ${MEMBERSHIP_COLUMNS}`,
      [input.tenantId, input.sub, input.by, input.reason ?? '', input.revokedAt ?? null],
    );
    return this.requireActive(rows[0]);
  }

  async revokeSessions(input: MembershipChange): Promise<MembershipRecord> {
    checkChange(input);
    const { rows } = await this.db.query<MembershipRow>(
      `UPDATE tenant_memberships
          SET changed_by = $3, reason = $4, tokens_valid_after = GREATEST(tokens_valid_after, COALESCE($5::timestamptz, now()))
        WHERE tenant_id = $1 AND sub = $2 AND status = 'active'
        RETURNING ${MEMBERSHIP_COLUMNS}`,
      [input.tenantId, input.sub, input.by, input.reason ?? '', input.revokedAt ?? null],
    );
    return this.requireActive(rows[0]);
  }

  async show(tenantId: string, sub: string): Promise<MembershipRecord | undefined> {
    const { rows } = await this.db.query<MembershipRow>(`SELECT ${MEMBERSHIP_COLUMNS} FROM tenant_memberships WHERE tenant_id = $1 AND sub = $2`, [tenantId, sub]);
    return rows[0] ? toMembershipRecord(rows[0]) : undefined;
  }

  private requireActive(row: MembershipRow | undefined): MembershipRecord {
    if (!row) throw new MembershipAdminError('not-active', 'That person is not an active member of this organization.');
    return toMembershipRecord(row);
  }
}
