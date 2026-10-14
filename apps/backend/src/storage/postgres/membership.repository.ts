import { Injectable } from '@nestjs/common';
import { Database } from '../../db/database';
import type { MembershipRecord } from '../../membership/membership';
import { type MembershipRow, toMembershipRecord } from '../../membership/pg-membership-admin';

const MEMBERSHIP_COLUMNS_QUALIFIED = `m.tenant_id, m.sub, m.status, m.roles, floor(extract(epoch FROM m.tokens_valid_after))::bigint AS tokens_valid_after_s, m.version`;
import { MembershipRepository } from '../membership.repository';

/**
 * One primary-key lookup per protected request, under row-level security (the application role sees only its own organization's rows).
 * Never cached: an allow decision is re-read every time, so a removal takes effect on the next request on every API instance.
 */
@Injectable()
export class PostgresMembershipRepository extends MembershipRepository {
  constructor(private readonly db: Database) {
    super();
  }

  find(tenantId: string, sub: string): Promise<MembershipRecord | undefined> {
    return this.db.withTenant(tenantId, async (client) => {
      // The organization's own row (row-level security lets the application role see only that one). A membership whose organization is not registered
      // cannot exist (foreign key), but a suspended one is refused by the caller.
      const { rows } = await client.query<MembershipRow & { tenant_status: string | null }>(
        `SELECT ${MEMBERSHIP_COLUMNS_QUALIFIED}, t.status AS tenant_status
           FROM tenant_memberships m LEFT JOIN tenants t ON t.id = m.tenant_id WHERE m.tenant_id = $1 AND m.sub = $2`,
        [tenantId, sub],
      );
      return rows[0] ? { ...toMembershipRecord(rows[0]), tenantActive: rows[0].tenant_status === 'active' } : undefined;
    });
  }
}
