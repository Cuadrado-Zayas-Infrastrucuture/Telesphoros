import { timingSafeEqual } from 'node:crypto';
import type { Role } from '@telesphoros/shared-types';
import type { InvitationDigest } from '../members/invitation-digest';
import { MembershipAdminError, type MembershipRecord } from './membership';
import { PgMembershipAdmin, type Queryable } from './pg-membership-admin';

export interface InvitationRecord {
  id: string;
  tenantId: string;
  emailHint: string;
  roles: Role[];
  status: 'pending' | 'fulfilled' | 'cancelled' | 'expired';
  expiresAt: Date;
  createdBy: string;
}

interface Row {
  id: string;
  tenant_id: string;
  email_hint: string;
  roles: string[];
  status: 'pending' | 'fulfilled' | 'cancelled';
  expires_at: Date;
  created_by: string;
  email_digest: Buffer;
  expired: boolean;
}

const COLUMNS = `id, tenant_id, email_hint, roles, status, expires_at, created_by, email_digest, (status = 'pending' AND expires_at <= now()) AS expired`;
const toRecord = (r: Row): InvitationRecord => ({ id: r.id, tenantId: r.tenant_id, emailHint: r.email_hint, roles: r.roles as Role[], status: r.expired ? 'expired' : r.status, expiresAt: r.expires_at, createdBy: r.created_by });

/**
 * What the operator does with an invitation (the organization administrator only records it). Over a connection that owns the tables: the migration
 * login the operator command uses, a superuser in tests. The application can create no identity, so an operator creates the account in the identity
 * provider and then fulfils the invitation with the person's subject id; the address must match the digest, and the membership is granted with the roles
 * the administrator asked for, in the same transaction that marks the invitation fulfilled.
 */
export class PgInvitationAdmin {
  constructor(
    private readonly db: Queryable,
    private readonly digest: InvitationDigest,
  ) {}

  async list(tenantId: string): Promise<InvitationRecord[]> {
    return (await this.db.query<Row>(`SELECT ${COLUMNS} FROM invitations WHERE tenant_id = $1 ORDER BY created_at DESC`, [tenantId])).rows.map(toRecord);
  }

  async fulfil(input: { id: string; email: string; sub: string; by: string }): Promise<MembershipRecord> {
    await this.db.query('BEGIN');
    try {
      const { rows } = await this.db.query<Row>(`SELECT ${COLUMNS} FROM invitations WHERE id = $1 FOR UPDATE`, [input.id]);
      const row = rows[0];
      if (!row) throw new MembershipAdminError('invalid', 'There is no such invitation.');
      if (row.status !== 'pending') throw new MembershipAdminError('invalid', `That invitation is already ${row.status}.`);
      if (row.expired) throw new MembershipAdminError('invalid', 'That invitation has expired. Ask the administrator to send a new one.');
      const wanted = this.digest.digest(input.email);
      if (wanted.length !== row.email_digest.length || !timingSafeEqual(wanted, row.email_digest)) {
        throw new MembershipAdminError('invalid', 'That address is not the one the invitation was made for.');
      }
      const membership = await new PgMembershipAdmin(this.db).grant({ tenantId: row.tenant_id, sub: input.sub, roles: row.roles as Role[], by: input.by, reason: `invitation ${row.id}` });
      await this.db.query(`UPDATE invitations SET status = 'fulfilled', decided_by = $2, decided_at = now(), fulfilled_sub = $3 WHERE id = $1`, [row.id, input.by, input.sub]);
      await this.db.query('COMMIT');
      return membership;
    } catch (error) {
      await this.db.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }
}
