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

## Slice 1: capability schema, inert (T006–T012), 2026-10-20

**What changed.**
- **Migration `0028_tenant_capability`** (`-- compat: expand`):
  - The NOLOGIN owner `telesphoros_capability` and the NOLOGIN group `telesphoros_issuer`.
  - Tables `tenant_capabilities` (only `sha256(token)`), `capability_issuance_log` (every attempt, append-only), `capability_purposes` (`request`: 60 s; limits counted, not enforced) and `tenant_binding_mode` (`guc`).
  - Functions `tenant_capability_issue` (EXECUTE: `telesphoros_issuer` only), `app_tenant()` / `app_actor()` (EXECUTE: the app, worker, ledger, redactor and jobs roles) and `tenant_capabilities_sweep` (EXECUTE: `telesphoros_jobs`).
  - Read-everything `SELECT` policies on `tenants` and `tenant_memberships` for `telesphoros_capability` only.
  - No existing policy or function is changed, so DATA-01 is still open, and the new spec asserts that on purpose.
- **`provision-logins`**: a fifth login, `telesphoros_session_issuer`, created only when `PROVISION_SECRET_ISSUER` is set. It is checked as a member of exactly `telesphoros_issuer`, able to mint, and unable to read any table. The migrator also gets `SET` on `telesphoros_capability`, as it has on the other definer roles.
- **`migration-lint`** (founder decision D, 2026-10-20): an `expand` migration may use a `REVOKE` that only undoes what the same file created. That means the default PUBLIC privilege on a function or table the file creates and no earlier migration names, or the exact reverse of an earlier `GRANT` in the file, to a role the file creates. Without the earlier migrations' SQL, nothing is exempt.
- **`append-only-tables.ts`**: the four tables classified as `CAPABILITY_TABLES`.

**Tests written first, and what they showed before the code existed:**

| Suite | Before | After |
|---|---|---|
| `migration-lint.spec.ts`, new REVOKE block (15) | the 4 "accept" cases failed; every refusal case already passed (positive controls) | 51/51 |
| `tenant-capability.pg-spec.ts` (33) | 30 of 32 failed; the 2 that passed state today's facts (app login is not a superuser; a forged tenant setting reads org-beta) | 33/33 |
| `provision-logins.pg-spec.ts`, issuer block (4) | failed (fifth login unknown) | pass |

**Mutants** (each must turn its suite red):

| Mutant | Result |
|---|---|
| Lint L1: ignore earlier migrations | red (1 failed) |
| Lint L2: any role may be un-granted | red (2 failed) |
| Lint L3: permissive default when the earlier SQL is not given | red (1 failed) |
| Lint L4: the GRANT may come after the REVOKE | red (1 failed) |
| M1 `tenant_capabilities` readable by the app | red: 1 of 33 (`every other login is refused: SELECT * FROM tenant_capabilities`) |
| M2 issue skips the membership version | red: 1 of 33 (`refuses a stale membership version`) |
| M3 `app_tenant()` ignores expiry | red: 1 of 33 (`a forged, oversized, expired or revoked token resolves to nothing`) |
| M4 `app_tenant()` lets the setting disagree | red: 1 of 33 (`… resolve to nothing (fail closed, no winner)`) |
| M5 fallback left on in `capability` mode | red: 1 of 33 (`only the guc and dual modes fall back`) |
| M6 the app may mint | red: 1 of 33 (`every other login is refused: … tenant_capability_issue …`) |
| M7 `app_actor()` trusts the actor setting | red: 1 of 33 (`the person comes from the capability`) |
| M8 issue ignores a suspended organization | red: 1 of 33 (`refuses a suspended organization`) |

Each mutant was applied to `0028_tenant_capability.up.sql` alone and the spec run. The file was then restored, and its SHA-256 matched the original after all eight.

**Existing tests updated because a migration was added** (hand-written expectations, not behaviour):
- The down-step counts, up lists, migration count and seeded-row count that assumed 0027 was the newest: `migrations`, `security-events`, `browser-session`, `browser-session-clock` (now runs its 0027 owner test against a copy of the migrations up to 0027, `test/helpers/migrations-through.ts`), `report-evidence`, `report-registration`, `recommendation-integrity`, `ledger-migration`, `security-audit`, `recovery-cli` and `backup-restore`.
- The non-superuser migrator in `ledger-migration` now gets `SET` on `telesphoros_capability`, which mirrors `provision-logins`. **Without it, 0028 failed for a non-superuser migrator** (`permission denied to grant role`); the test caught this.
- `schema-acceptance` reviews the new keys, checks, foreign keys and query indexes.
- `ledger-catalog` names the two new read-everything policies.

**Local runs** (macOS; Node 22.22.0 and Unicode 16.0, as CI pins; PostgreSQL 16.14 with scram-sha-256 password auth, as CI; moto for S3):

| Step | Result |
|---|---|
| `pnpm install --frozen-lockfile`, `build`, `typecheck`, `lint` | pass |
| Tier 1, `pnpm --filter @telesphoros/backend test` with the database and S3 | 163 suites passed, 11 skipped (tier 2 and 3 only), 0 failed; 2366 tests passed, 256 skipped; no skip notice printed |
| Tier 2, `TEST_STORAGE=postgres` | 172 passed, 2 skipped (S3 only), 0 failed; 2601 tests passed |
| Tier 3, `TEST_STORAGE=postgres TEST_OBJECT_STORAGE=s3` | 174 of 174 passed; 2621 tests passed, 1 skipped |
| Worker, `pnpm --filter @telesphoros/worker test` | 14 files, 169 of 169 tests |
| Root `pnpm test` (no database variables, as `verify` runs it) | pass |
| `pnpm test:infra`, `pnpm test:ci-config` | 122 of 122, 144 of 144 |

Run on `feat/tenant-capability-slice1` over `main` `5a3ba8f`. Two earlier runs on the older base found the stale expectations listed above, and the run on this base found two more: `backup-restore` (the 2 seeded rows) and `recovery-cli` (28 migrations).

**Local environment notes:** the backup and restore suites need PostgreSQL 16 client and server tools, and on macOS `LC_ALL` set. Without `LC_ALL`, the recovery target's server stops with "postmaster became multithreaded". This run put `/opt/homebrew/opt/postgresql@16/bin` first on `PATH` and set `LC_ALL=en_US.UTF-8`. Without them, the same eight suites fail on unmodified `main` too.

**Not verified anywhere:** an AWS environment or RDS; the issuer process itself, which arrives in slice 2; and hosted CI on this branch (pending when this was written).

**Deviations from the plan, for review:**
1. Issuance is audited in `capability_issuance_log`, not `security_events`. A new event type there needs a breaking constraint change, and one event per request would flood the table.
2. The membership is read without a row lock. `FOR SHARE` needs `UPDATE` on `tenant_memberships`. A removal that commits during an issue can leave one capability usable for reads until it expires (60 s); writes are still refused at commit.
3. There is no `BEFORE TRUNCATE` trigger on the log, because the compat lint reads that trigger as the statement. Only the NOLOGIN owner can truncate it.
4. The sweep's scheduled job is wired in slice 2. The function exists and is tested.
5. A second definer role now reads every organization: `telesphoros_capability` has `USING (true)` `SELECT` policies on `tenants` and `tenant_memberships`, as `telesphoros_jobs` already has on `tenants`. It needs them to check a membership before it mints. No login is a member of it. The `ledger-catalog` guard names both policies.
