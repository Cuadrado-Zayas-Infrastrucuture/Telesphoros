# Tenant capability (DATA-01): verification record

Slice 1 of `specs/001-tenant-capability/` (spec, plan and tasks in PR #191; plan approved by the founder 2026-10-19). This file records what was run, what it showed and what remains unverified. Later slices append below.

## Phase 1 inventory (T001–T005), 2026-10-19

**Scope.** Read-only. Nothing in the repository changed except this file.

**Method.**
- **Database.** Migrations 0001–0027 from `main` `ac7bc72` were applied to a disposable PostgreSQL 16.14 container (`docker run postgres:16`, loopback port, trust auth, destroyed afterwards), using `node dist/db/cli.js migrate up` as the superuser. Because of that, functions owned by "the migrating login" show as `postgres`; in a deployment that is `telesphoros_migrator` (`apps/backend/src/db/privilege-facts.ts:10`).
- **Catalog.** The counts below come from `pg_policies`, `pg_class` and `pg_proc` with `has_function_privilege`, not from grep. The queries are at the end of this section.
- **Source.** The source lists come from the TypeScript in `apps/backend/src`, checked by hand (T005).

### T001: row-level security policies

| Measure | Count |
|---|---|
| Tables in `public` with RLS enabled | 33 |
| …of which RLS is **not** forced (the owner bypasses it) | 9: `invitations`, `ledger_checkpoints`, `ledger_events`, `ledger_heads`, `ledger_incident_clearances`, `ledger_incidents`, `security_audit_events`, `tenant_memberships`, `tenants` |
| Policies | 73 |
| …that read `app.current_tenant_id` | **48** |
| …that read `app.current_actor` or `app.current_owner_id` | 0 |
| …that are open (`USING (true)`) | 25: 21 for `telesphoros_ledger_verifier` or `_operator`, 4 for `telesphoros_jobs` |
| Tables `telesphoros_app` holds a grant on without RLS | 1: `schema_migrations` (SELECT) |

The 48 tenant-setting policies, by the role they apply to (a policy with two roles counts once for each):

| Role | Policies | Tables |
|---|---|---|
| `telesphoros_app` | 30 | `browser_sessions` (4, one per command), `capture_acceptances`, `cell_dispute_decisions`, `cell_disputes`, `corrections`, `evaluation_gene_states`, `evaluation_results`, `evaluations`, `event_notes`, `file_verifications`, `invitations`, `job_attempts`*, `jobs`*, `ledger_checkpoints`, `ledger_events`, `ledger_heads`, `patient_duplicate_flags`, `patient_identifiers`, `patient_merge_decisions`, `patient_merge_proposals`, `patients`, `recommendations`, `report_captures`, `report_patient_decisions`, `reports`, `tenant_memberships`, `tenants` (keyed on `id`) |
| `telesphoros_worker` | 2 | `jobs`*, `job_attempts`* (*the same policies as the app's) |
| `telesphoros_ledger` | 12 | read-only copies on `capture_acceptances`, `cell_dispute_decisions`, `cell_disputes`, `corrections`, `evaluation_gene_states`, `evaluation_results`, `evaluations`, `event_notes`, `patient_merge_decisions`, `patient_merge_proposals`, `report_captures`, `report_patient_decisions` |
| `telesphoros_redactor` | 2 | `event_notes` (SELECT, UPDATE) |
| `telesphoros_jobs` | 2 | `reports`, `report_captures` (SELECT) |
| **PUBLIC** (no `TO` clause) | 2 | `report_upload_runs`, `report_upload_attempts` (`0015_upload_attempts.up.sql:12`, `:34`); granted to `telesphoros_app` (SELECT, INSERT, UPDATE) and `telesphoros_jobs` (SELECT, UPDATE) |

### T002: definer and trigger functions

There are 66 functions in `public` that are SECURITY DEFINER, are triggers, or mention `app.current_*`. Each is classified for the plan. Class (a) takes identity from the caller and must change. Class (b) sets the tenant itself from a row or argument, and must set it before it reads. Class (c) does neither.

**Class (a), callable by `telesphoros_app` directly (10 + 1):**

| Function | Owner | Reads | Note |
|---|---|---|---|
| `job_enqueue` | `telesphoros_jobs` | tenant, actor | `0023:140-141` |
| `outbox_append` | `telesphoros_jobs` | tenant | `0024:93` |
| `ledger_append` | `telesphoros_ledger` | tenant (and via `ledger_append_internal`: tenant, actor) | `0011:193`, `0005:151-152` |
| `membership_assert_current` | migrating login | tenant | `0017:77`; called by `database.ts:113` |
| `security_event_append` | migrating login | tenant, actor | `0022:17-18` (redefines `0018:74-75`) |
| `member_change_roles`, `member_remove`, `invitation_create`, `invitation_cancel` | migrating login | tenant, actor through the invoker helper `member_admin_context` | `0019:112-113`, called at `0019:136`, `:157`, … |
| `security_audit_record` | `telesphoros_ledger` | **neither: tenant and actor are plain parameters** | `0016:37-45`; called by `database.ts:132` |

**Class (a), reached only through other roles or triggers:**

| Function | How it runs | Reads |
|---|---|---|
| `ledger_append_internal` | definer `telesphoros_ledger`; called by `ledger_append` (app) and EXECUTE for `telesphoros_redactor` (through `redact_event_note`, used by the operator login) | tenant, actor |
| `tenant_memberships_audit` | invoker trigger on `tenant_memberships`, fires on member-admin writes | actor (person vs operator, `0019:211`) |
| `patient_identifiers_guard` | invoker trigger on `patient_identifiers`, fires on app writes | actor (`0020:41`) |
| `member_admin_context` | invoker, called only from the four member-admin definer functions | tenant, actor |

**Class (b), sets the tenant itself:**

| Function | Sets from | EXECUTE by |
|---|---|---|
| `ledger_record_checkpoint` (two overloads) | argument `p_tenant`, actor `'ledger-verifier'` (`0005:252-253`, `0011:84-85`) | `telesphoros_ledger_verifier` |
| `job_held` | the job row (`0024:165`) | `telesphoros_jobs` only |
| `uploads_sweep` | argument `p_tenant` (`0024:245`) | `telesphoros_jobs` only (the CLI reaches it as the migrator; `apps/backend/src/reports/intake/sweep.ts:21`) |

**Class (c):** the remaining worker-callable definer functions (`job_claim`, `job_heartbeat`, `job_succeed`, `job_fail`, `job_release`, `job_schedule_tick`, `job_stats`, `job_worker_seen`, `outbox_relay`, `file_verification_*`, `job_uploads_sweep`) take the tenant from the job or row and read no setting. So do the ledger operator and verifier functions (`ledger_set_global_hold`, `ledger_clear_incident`, `ledger_record_incident`). The remaining ledger triggers (`ledger_event_row_exists`, `ledger_row_has_event`, `ledger_heads_guard`, `evaluation_child_guard`, `event_notes_guard`) read no setting **themselves**. They run as `telesphoros_ledger`, however, and read through that role's 12 tenant-setting policies, so their reads are bound to the caller's setting.

### T003: `withTenant` call sites

There are **46** call sites in `apps/backend/src`, excluding specs and `database.ts` itself, across the 9 repositories named in the plan plus `security-events.ts`. **5** pass `{ actor }`:
- `ledger-records.repository.ts:566` (`write`)
- `member-admin.repository.ts:88` (`run`)
- `patient-identifiers.repository.ts:33` (`add`) and `:78` (`withdraw`)
- `security-events.ts:94` (`append`)

The other **41** bind only the tenant: `reports.repository.ts` 24, `patients.repository.ts` 6, `recommendations.repository.ts` 3, `patient-identifiers.repository.ts` 3, `member-admin.repository.ts` 2, `ledger-records.repository.ts` 1, `membership.repository.ts` 1, `browser-session.repository.ts` 1.

How the count was made: a script finds each call and looks for `actor` anywhere inside the call's parentheses. The first version looked only three lines ahead and missed `security-events.ts:94`, where `{ actor }` sits on the fourth line. The T005 spot check caught that, and the counts above are from the corrected script.

### T004: work without a request authority, and other logins

| Site | What it is | Planned fate |
|---|---|---|
| `security-events.ts:87` (`asOrganizationWork`) | Records an `access.refused` event for a person whose authority was just refused, inside that request | Use the request's capability; record as organization work (D5 / D6) |
| `reports/intake/intake.service.ts:181`, `:208` (`asOrganizationWork`) | Upload housekeeping (cancel or settle an attempt, release a reservation) that must still run if the person was removed mid-request, inside that request | Use the request's capability |
| `LedgerMonitor` (`ledger/ledger-monitor.ts`) | Startup and periodic ledger watch | Uses the **verifier** login, not the app login; outside DATA-01's threat as written |
| `RateLimitService` sweep (`rate-limit/rate-limit.service.ts:39`, `:57`) | Interval sweep | In-memory only; no database |
| `db/cli.ts` commands (`migrate`, `uploads sweep`, `provision-logins`, audits, restore) | Operator tools | Use `DATABASE_MIGRATOR_URL`, `DATABASE_AUDITOR_URL` or `DATABASE_ADMIN_URL`, never the app login |
| `db/restore.ts:288-296` (`verifyIsolation`) | Post-restore check: `SET LOCAL ROLE telesphoros_app` plus the tenant setting must show the tenant's rows | **Breaks in `capability` mode** (it would see 0). Owner: recovery tooling. It must change in slice 5, either to mint a capability through the issuer function or to expect 0 with the setting alone and the counts with a capability |

No API code path was found that reaches tenant data through the app login outside an HTTP request. The interval and timer sites listed above (`setInterval`, `setTimeout`, `OnApplicationBootstrap`) were each read. **Not covered:** dynamic paths that grep cannot see, such as a timer created by a library.

### T005: hand spot checks (two per list)

| List | Item | Read | Agrees |
|---|---|---|---|
| T001 | `patients_tenant` | `0003_tenancy.up.sql:81-83` | yes |
| T001 | `upload_run_tenant` is PUBLIC | `0015_upload_attempts.up.sql:12` has no `TO` clause | yes |
| T002 | `job_enqueue` reads tenant and actor | `0023:140-141` | yes |
| T002 | `job_claim` reads no setting | `0023_jobs.up.sql` body: 0 `current_setting` | yes |
| T003 | `security-events.ts:94` passes `{ actor }` | source | **no, first script missed it**; corrected |
| T003 | `patients.repository.ts:41` binds tenant only | source | yes |
| T004 | `intake.service.ts:181` runs inside the request | source, lines 170-212 | yes |
| T004 | `restore.ts:292` relies on the setting granting rows | source, lines 282-296 | yes |

### Findings that change the approved spec (for review)

1. **FR-006 is too narrow.** It names policies for `telesphoros_app` and `telesphoros_worker` (32). The catalog has 16 more tenant-setting policies: 12 for `telesphoros_ledger`, 2 for `telesphoros_redactor`, 2 for `telesphoros_jobs`. The 2 PUBLIC policies sit on tables the app writes. The ledger triggers and `ledger_append` run as `telesphoros_ledger` **inside the app's transaction**, so a forged setting reaches them. The proposed fix: FR-006 and FR-010 cover **every** non-open policy that reads the setting. The only exceptions are the class (b) functions' own reads, made after they set it. That is an edit to `spec.md` in #191.
2. **Two class (a) triggers the spec did not name:** `patient_identifiers_guard` (`0020:41`) and `tenant_memberships_audit` (`0019:211`). Both read the actor and must use `app_actor()`.
3. **D5 resolves to "no background path".** All 3 organization-work sites run inside a request. That constrains slice 2: **mint one capability per request and reuse it for every `withTenant` call in that request**, not one per call. Otherwise the organization-work calls after a removal could not obtain one. D1's 60 s lifetime covers a request (`statement_timeout` 5 s).
4. **`restore.ts` `verifyIsolation` must change in slice 5** (T004); add it to tasks T031.
5. **Out of scope, recorded:** the verifier login reads every tenant by design (`USING (true)`), the operator login reaches `ledger_append_internal` with its own setting, and 9 RLS tables are not forced. Those belong to DATA-03 and the operator review, not to this slice.

### Queries used

```sql
-- T001
SELECT tablename, policyname, cmd, roles, qual, with_check FROM pg_policies WHERE schemaname = 'public';
SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity;
-- T002 (for each telesphoros_* group role r)
SELECT p.proname, pg_get_function_identity_arguments(p.oid), pg_get_userbyid(p.proowner), p.prosecdef,
       p.prorettype = 'trigger'::regtype, has_function_privilege(r, p.oid, 'EXECUTE'),
       p.prosrc ~ 'current_setting\(.app\.current_(tenant_id|actor)', p.prosrc ~ 'set_config\(.app\.current_(tenant_id|actor)'
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND (p.prosecdef OR p.prorettype = 'trigger'::regtype OR p.prosrc ~ 'app\.current_');
```

**Not verified here:** anything on RDS or staging; the role memberships of deployed logins; whether the PUBLIC policies were meant to be PUBLIC (they behave correctly today because only the app and jobs roles hold grants).
