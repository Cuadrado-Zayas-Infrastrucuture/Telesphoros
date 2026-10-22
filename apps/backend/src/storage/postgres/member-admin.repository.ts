import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { Role } from '@telesphoros/shared-types';
import type { Principal } from '../../auth/principal';
import { Database } from '../../db/database';
import { type InvitationView, MemberAdminRepository, MemberAdminRuleError, type MemberRule, type MemberView, type PageRequest } from '../member-admin.repository';

interface InvitationRow {
  id: string;
  email_hint: string;
  roles: string[];
  status: 'pending' | 'fulfilled' | 'cancelled';
  expires_at: Date;
  created_at: Date;
  expired: boolean;
}

const KNOWN_RULES: readonly string[] = ['member-self', 'member-not-found', 'last-administrator', 'not-administrator', 'tenant-inactive', 'invitation-limit', 'invitation-not-found'];

const INVITATION_COLUMNS = `id, email_hint, roles, status, expires_at, created_at, (status = 'pending' AND expires_at <= now()) AS expired`;
const toInvitation = (r: InvitationRow): InvitationView => ({
  id: r.id,
  emailHint: r.email_hint,
  roles: r.roles as Role[],
  status: r.expired ? 'expired' : r.status,
  expiresAt: r.expires_at,
  createdAt: r.created_at,
});

/** The database function raised a rule: translate it to its stable name. Anything else is not ours and is rethrown untouched. */
function asRule(error: unknown): unknown {
  const { message, code, constraint } = (error ?? {}) as { message?: string; code?: string; constraint?: string };
  if (message && KNOWN_RULES.includes(message)) return new MemberAdminRuleError(message as MemberRule);
  // The function raises 'member-admin-context' when no organization or person is bound to the transaction: the caller is not a valid administrator.
  if (message === 'member-admin-context') return new MemberAdminRuleError('not-administrator');
  if (code === '23505' && constraint === 'invitations_one_pending_uq') return new MemberAdminRuleError('invitation-pending');
  return error;
}

/** Calls the SECURITY DEFINER functions. The application role has no write privilege on the tables, so this is the only way in. */
@Injectable()
export class PostgresMemberAdminRepository extends MemberAdminRepository {
  constructor(private readonly db: Database) {
    super();
  }

  listMembers(tenantId: string, { offset, limit }: PageRequest): Promise<{ items: MemberView[]; total: number }> {
    return this.db.withTenant(tenantId, async (client) => {
      const rows = await client.query<{ sub: string; roles: string[]; changed_at: Date }>(
        `SELECT sub, roles, changed_at FROM tenant_memberships WHERE tenant_id = $1 AND status = 'active' ORDER BY sub LIMIT $2 OFFSET $3`,
        [tenantId, limit, offset],
      );
      const total = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM tenant_memberships WHERE tenant_id = $1 AND status = 'active'`, [tenantId]);
      return { items: rows.rows.map((r) => ({ sub: r.sub, roles: r.roles as Role[], changedAt: r.changed_at })), total: total.rows[0]!.n };
    });
  }

  async changeRoles(actor: Principal, sub: string, roles: Role[]): Promise<void> {
    await this.run(actor, (client) => client.query('SELECT member_change_roles($1, $2::text[])', [sub, roles]));
  }

  async removeMember(actor: Principal, sub: string): Promise<void> {
    await this.run(actor, (client) => client.query('SELECT member_remove($1)', [sub]));
  }

  /** The one write that moves the caller's own membership version, so it opts out of the post-work recheck (see TenantWorkOptions). */
  async signOut(actor: Principal): Promise<void> {
    try {
      await this.db.withTenant(actor.tenantId, (client) => client.query('SELECT member_sign_out()'), { actor: actor.sub, ownVersionMayChange: true });
    } catch (error) {
      throw asRule(error);
    }
  }

  createInvitation(actor: Principal, invitation: { digest: Buffer; hint: string; roles: Role[] }): Promise<InvitationView> {
    return this.run(actor, async (client) => {
      const { rows } = await client.query<{ id: string }>('SELECT invitation_create($1, $2, $3::text[]) AS id', [invitation.digest, invitation.hint, invitation.roles]);
      const made = await client.query<InvitationRow>(`SELECT ${INVITATION_COLUMNS} FROM invitations WHERE id = $1 AND tenant_id = $2`, [rows[0]!.id, actor.tenantId]);
      return toInvitation(made.rows[0]!);
    });
  }

  listInvitations(tenantId: string, { offset, limit }: PageRequest): Promise<{ items: InvitationView[]; total: number }> {
    return this.db.withTenant(tenantId, async (client) => {
      const rows = await client.query<InvitationRow>(`SELECT ${INVITATION_COLUMNS} FROM invitations WHERE tenant_id = $1 ORDER BY created_at DESC, id LIMIT $2 OFFSET $3`, [tenantId, limit, offset]);
      const total = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM invitations WHERE tenant_id = $1', [tenantId]);
      return { items: rows.rows.map(toInvitation), total: total.rows[0]!.n };
    });
  }

  async cancelInvitation(actor: Principal, id: string): Promise<void> {
    await this.run(actor, (client) => client.query('SELECT invitation_cancel($1)', [id]));
  }

  private async run<T>(actor: Principal, work: (client: PoolClient) => Promise<T>): Promise<T> {
    try {
      return await this.db.withTenant(actor.tenantId, work, { actor: actor.sub });
    } catch (error) {
      throw asRule(error);
    }
  }
}
