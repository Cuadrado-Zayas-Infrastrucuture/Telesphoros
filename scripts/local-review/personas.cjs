// The demo's organizations and memberships, derived from the fake identity provider's own users, so the two cannot drift apart: a user whose
// groups name exactly one organization ("tenant:<id>") and at least one role becomes an active member of that organization with those roles.
// Anyone else (no organization, two organizations, no role) is left out on purpose: the API admits a person to one organization at a time,
// and those users exist to test refusals. Synthetic only.
const { DEFAULT_USERS } = require('../../packages/fake-idp/dist/index.js');

const ROLE_GROUPS = ['reader', 'clinician', 'admin', 'reviewer'];
const TENANT_PREFIX = 'tenant:';

function derivePersonas(users = DEFAULT_USERS) {
  const tenants = new Set();
  const grants = [];
  for (const user of users) {
    const orgs = user.groups.filter((g) => g.startsWith(TENANT_PREFIX)).map((g) => g.slice(TENANT_PREFIX.length));
    const roles = user.groups.filter((g) => ROLE_GROUPS.includes(g));
    if (orgs.length !== 1 || roles.length === 0) continue;
    tenants.add(orgs[0]);
    grants.push({ tenantId: orgs[0], sub: user.sub, email: user.email, roles });
  }
  return { tenants: [...tenants].sort(), grants };
}

module.exports = { derivePersonas, ROLE_GROUPS };
