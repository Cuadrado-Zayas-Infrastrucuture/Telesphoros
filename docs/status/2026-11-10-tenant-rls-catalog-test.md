# One catalog test for tenant isolation on every tenant table

Date: 2026-11-10

Row-level security was checked table by table, in the tests of the feature that added each table. Nothing failed if a new table with a `tenant_id` column was added without it. `apps/backend/test/db/tenant-rls-catalog.pg-spec.ts` now finds every such table in a migrated database and checks all of them at once. It changes no migration, policy or application code.

What it requires:

- Row-level security is enabled on every table with a `tenant_id` column, and forced on every one except a named list, each entry with its reason. A new unforced table fails, and so does a listed table that is now forced.
- No application role (`telesphoros_app`, `telesphoros_worker`) owns such a table, is a superuser or bypasses row-level security.
- Every granting policy that reaches an application role, or PUBLIC, requires the caller's tenant in each of its expressions, with no `OR`.
- A table an application role holds a privilege on has a policy for that role.
- A view that shows `tenant_id` runs as its caller, and no materialized view copies tenant rows.

## What it found

The schema passes as it is: 62 tables carry `tenant_id`, 52 are forced, and no application policy is open.

Ten tables are enabled but not forced, so their owner role is not bound by their policies. Six say why in their migration: `ledger_events`, `ledger_heads`, `ledger_checkpoints`, `ledger_incidents`, `security_events` and `tenant_memberships`. Four state no reason: `invitations`, `security_audit_events`, `tenant_capabilities` and `capability_issuance_log`. The test lists all ten as they are today and marks those four as not endorsed. Whether to force any of them is a schema change and an open decision.

The rule is by column name. A table that holds tenant data under another column name is outside it; `agentic_synthetic_capacity` (`tenant_day_units`, no row-level security) is the one such table today.
