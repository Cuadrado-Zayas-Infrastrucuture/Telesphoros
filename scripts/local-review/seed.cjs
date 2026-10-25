// Registers the demo organizations and grants the demo users their memberships, over a connection that owns the tables (the demo owner).
// Safe to run twice: an organization that exists is left alone, a membership with the same roles is left alone, different roles are replaced.
// Since the live-membership slice the API reads each person's standing from the database, so without this every demo user is refused (403).
const { derivePersonas } = require('./personas.cjs');

const BY = 'demo-setup';
const REASON = 'local demo persona';

async function seedPersonas(db, users) {
  const { PgTenantAdmin } = require('../../apps/backend/dist/membership/pg-tenant-admin');
  const { PgMembershipAdmin } = require('../../apps/backend/dist/membership/pg-membership-admin');
  const { tenants, grants } = derivePersonas(users);
  const tenantAdmin = new PgTenantAdmin(db);
  const memberships = new PgMembershipAdmin(db);
  const registered = new Set((await tenantAdmin.listTenants()).map((t) => t.id));
  for (const id of tenants) {
    if (registered.has(id)) continue;
    await tenantAdmin.registerTenant({ id, displayName: `${id[0].toUpperCase()}${id.slice(1)} synthetic clinic`, by: BY });
  }
  let changed = 0;
  for (const grant of grants) {
    const existing = await memberships.show(grant.tenantId, grant.sub);
    const input = { tenantId: grant.tenantId, sub: grant.sub, roles: grant.roles, by: BY, reason: REASON };
    if (existing && existing.status === 'active') {
      if (existing.roles.length === grant.roles.length && grant.roles.every((r) => existing.roles.includes(r))) continue;
      await memberships.setRoles(input);
    } else {
      await memberships.grant(input);
    }
    changed += 1;
  }
  return { tenants: tenants.length, members: grants.length, changed };
}

module.exports = { seedPersonas };
