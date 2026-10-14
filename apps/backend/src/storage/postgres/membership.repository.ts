import { Injectable } from '@nestjs/common';
import { Database } from '../../db/database';
import type { MembershipRecord } from '../../membership/membership';
import { MEMBERSHIP_COLUMNS, type MembershipRow, toMembershipRecord } from '../../membership/pg-membership-admin';
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
      const { rows } = await client.query<MembershipRow>(`SELECT ${MEMBERSHIP_COLUMNS} FROM tenant_memberships WHERE tenant_id = $1 AND sub = $2`, [tenantId, sub]);
      return rows[0] ? toMembershipRecord(rows[0]) : undefined;
    });
  }
}
