# Four tables stay unforced, now with their reasons (GAP-07)

Date: 2026-11-11

The tenant row-level security catalog test (`apps/backend/test/db/tenant-rls-catalog.pg-spec.ts`) listed four tables whose row-level security
is enabled but not forced, with "no reason stated" (gap GAP-07). The founder asked for them to be forced. Each was forced in a scratch
migration and the suites that use them were run against PostgreSQL 16 (`TEST_STORAGE=postgres`):

- **All four forced:** 68 of 120 tests failed across `tenant-capability`, `request-capability`, `capability-sweep` and `security-audit`.
  Writes to `capability_issuance_log` were refused 39 times ("new row violates row-level security policy"), a write to `security_audit_events`
  was refused, and capability lookups and the sweep found nothing. The `invitation-registration` and `member-admin` suites passed.
- **`invitations` alone forced:** 249 of 250 tests passed across the 8 suites that mention invitations; the one failure was the catalog test
  asking for the table to come off its list. That pass does not carry to staging: the operator command (`db invite`, `PgInvitationAdmin`)
  runs as the migration login that owns the table, and in the tests that login is a superuser, which `FORCE` does not bind. On RDS the owner
  is the non-superuser migrator, so forcing would leave the operator command reading no invitations.

`FORCE` binds only a table's owner. Every path to these four tables runs as the owner by design: `SECURITY DEFINER` functions that must work
before a tenant is known or across organizations (`app_tenant()` and the other capability lookups, `tenant_capability_issue`, the capability
sweep, `security_audit_record`), and the operator command. An owner policy wide enough to keep them working would be `USING (true)`, which
is the same as not forcing. So they stay unforced, and the catalog test now names the real reason for each in place of "no reason stated".

Not changed: no migration, policy, grant or code. The application and worker roles are bound by row-level security on these tables as before:
they have no policy on three of them and a tenant-bound read on `invitations`.

What would actually remove the owner's reach is a separate change: give these tables to a role nobody can log in as, and move the operator's
invitation work into functions. It is not proposed here.

Not proved: the operator command against a forced `invitations` table with a non-superuser owner. No test runs migrations as a
non-superuser owner, so that case was read from the code, not run.
