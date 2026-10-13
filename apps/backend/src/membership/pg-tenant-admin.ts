import { tenantIdSchema } from '@telesphoros/shared-types';
import { MAX_TENANT_NAME, MembershipAdminError, type TenantAdmin, type TenantRecord } from './membership';
import type { Queryable } from './pg-membership-admin';

interface TenantRow {
  id: string;
  display_name: string;
  status: 'active' | 'suspended';
}
const toRecord = (r: TenantRow): TenantRecord => ({ id: r.id, displayName: r.display_name, status: r.status });
// eslint-disable-next-line no-control-regex -- the point is to refuse control characters
const CONTROL = /[\u0000-\u001f\u007f]/;

export function checkTenantInput(id: string, displayName: string | undefined, by: string): void {
  if (!tenantIdSchema.safeParse(id).success) throw new MembershipAdminError('invalid', 'The organization id must be lower-case letters, digits and dashes (1 to 63 characters, not starting with a dash).');
  if (displayName !== undefined && (displayName.trim().length < 1 || displayName.length > MAX_TENANT_NAME || CONTROL.test(displayName))) {
    throw new MembershipAdminError('invalid', `The organization name must be 1 to ${MAX_TENANT_NAME} characters without control characters.`);
  }
  if (!by || by.length > 128 || CONTROL.test(by)) throw new MembershipAdminError('invalid', 'by must be 1 to 128 characters without control characters.');
}

/** The organization registry over a connection that owns the table (the migration login the operator command uses; a superuser in tests). */
export class PgTenantAdmin implements TenantAdmin {
  constructor(private readonly db: Queryable) {}

  async registerTenant(input: { id: string; displayName: string; by: string }): Promise<TenantRecord> {
    checkTenantInput(input.id, input.displayName, input.by);
    const { rows } = await this.db.query<TenantRow>(
      `INSERT INTO tenants (id, display_name, created_by, changed_by) VALUES ($1, $2, $3, $3) ON CONFLICT (id) DO NOTHING RETURNING id, display_name, status`,
      [input.id, input.displayName.trim(), input.by],
    );
    if (!rows[0]) throw new MembershipAdminError('invalid', 'That organization is already registered.');
    return toRecord(rows[0]);
  }

  async setTenantStatus(input: { id: string; status: 'active' | 'suspended'; by: string }): Promise<TenantRecord> {
    checkTenantInput(input.id, undefined, input.by);
    const { rows } = await this.db.query<TenantRow>(`UPDATE tenants SET status = $2, changed_by = $3 WHERE id = $1 RETURNING id, display_name, status`, [input.id, input.status, input.by]);
    if (!rows[0]) throw new MembershipAdminError('unknown-tenant', 'That organization is not registered.');
    return toRecord(rows[0]);
  }

  async listTenants(): Promise<TenantRecord[]> {
    return (await this.db.query<TenantRow>(`SELECT id, display_name, status FROM tenants ORDER BY id`)).rows.map(toRecord);
  }
}
