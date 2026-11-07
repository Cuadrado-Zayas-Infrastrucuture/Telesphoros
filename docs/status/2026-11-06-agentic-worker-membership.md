# The P2 worker checks membership without the tenant setting (DATA-01 slice 5 readiness R2 and R5)

Date: 2026-11-06

Two of the items `specs/001-tenant-capability/tasks.md` lists as needed before slice 5 switches the binding mode to `capability`.

**R2.** On the synthetic agentic workflow's worker side, `agentic_synthetic_member_current` wrote `app.current_tenant_id` and called `membership_assert_current`. The worker has no capability, so in `capability` mode the organization resolved to nothing and every worker step would be refused. Migration 0073 (`breaking`) fixes it:
- it adds `membership_current_in(tenant, sub, version)`, a row-sourced membership lookup only `telesphoros_jobs` may call;
- `member_current` uses it and reads no setting;
- the migration checks that it replaces 0029's body, and its `down` restores that body byte for byte.

**R5.** It does not apply in production. The ai-service durable store is constructed only in tests, and its application-side calls have required a capability since migration 0030.

**Tests.**
- `agentic-identity.pg-spec.ts` claims and loads a run as the real worker login in all three binding modes, plus the lookup's own cases, its lock, privileges and revert: 38 tests.
- The `capability`-mode step failed before the migration. All 9 mutations turn the spec red (table in [the verification record](../verification/tenant-capability.md)).

**Not run.** The ai-service's own durable PostgreSQL suites: they need an owned PostgreSQL runtime outside this repository, and CI does not run them. Not verified in AWS. The binding mode stays `dual`.
