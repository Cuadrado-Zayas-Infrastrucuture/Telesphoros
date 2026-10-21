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


## Slice 3 PR A: the guard asks for the capability before it reads the membership, 2026-10-21 (local, not pushed)

**What changed.**
- **Migration `0031_tenant_capability_issue_current`** (`-- compat: expand`): `tenant_capability_issue_current(tenant, sub, purpose, hash, request)` (owner `telesphoros_capability`, `EXECUTE` to `telesphoros_issuer` only, `REVOKE ... FROM PUBLIC`; reads the person's current active membership version and issues through the unchanged six-argument function; returns `expires_at, refusal, membership_version`) and `app_capability_version()` (the version a presented capability was issued at; same expiry, revocation and tenant-mismatch rules as `app_tenant()`; `EXECUTE` to the same five roles as `app_tenant()`, not PUBLIC). The six-argument function and its grant stay. A person with no active membership is passed to the inner function as version 0, so the refusal is logged as `membership-not-current` at version 0. The down migration drops the two functions; a catalog snapshot (functions with owner, flags, settings and ACL; table ACLs; policies) after the down equals the snapshot at 0030 and the one after up-down-up equals the original.
- **Code.** `CapabilityIssueRequest.membershipVersion` is gone; `IssuedCapability`, `RequestCapability` and the issuer's HTTP answer carry it. `IssuerCore` and `PgCapabilityIssueStore` call the new function and refuse an issuance without a usable version. `AuthGuard` calls `RequestCapabilities.obtain` first, then `MembershipService.resolve` under the capability, and binds the authority to the version the capability carries. `duringAdmission`, `isAdmitting` and the `admitting` slot are deleted, so `withTenant` counts every call.
- **Refusals (decision D1=(i)).** When the issuer refused with `membership-not-current` or `tenant-inactive`, `resolve` does not write `access.refused` for `no-membership`, `removed` or `tenant-suspended`: the issuance-log row is the record. With no issuer configured, or one that failed, it still does (nothing else would). `token-revoked` and `authority-changed` are unchanged.
- **`provision-logins`**: the new functions' rights per login, checked only once 0031 exists (a database at 0028 still passes).
- **`migration-lint`** (a second commit): an `expand` migration may hand back a schema `CREATE` that the earlier migrations had already taken from an existing role (0031 lends it to `telesphoros_capability` for its own duration, as 0028 did for its new role). It is accepted only when this file granted the same privilege to that role earlier AND the last earlier mention of it for that role was a `REVOKE`.
- **Not touched:** policies, definer functions, the mode row (`guc`), Terraform, workflows, the audit writer, `MembershipService`'s decision table, `membership_assert_current`.

**What reads `security_events` for admission refusals** (searched `docs`, `infrastructure`, `.github`, `scripts`, `apps/*/src`): only the auditor's `security-events list` command (`security-events-cli.ts`) and the runbook `docs/ops/security-events.md` (event table, "No `access.refused` for a refusal" row), plus `docs/auth.md`, `docs/database.md` and `docs/STATUS.md` prose. No metric filter, alarm or other code reads the table or the `access.refused` type; the only issuer alarms match `Capability not issued: unavailable` and `refused (rate-limited)`. The runbook is updated. **Not verified:** anything outside the repository (a person's own notes, a SIEM, a dashboard).

**Tests written first, and what they showed against `main`'s code** (the new and changed specs copied onto a pristine `667cd41` checkout):

| Group | On `main`'s code | On this branch |
|---|---|---|
| Unit: `migration-lint`, `authority-context.capability`, `issuer-core`, `issuer-server`, `request-capabilities` | 96 of 224 failed (5 of 8 suites) | pass |
| PostgreSQL: `tenant-capability`, `issuer`, `issuer-server`, `provision-logins`, `database`, `request-capability`, `migrations`, and the new guard e2e | 73 of 186 failed (8 of 8 suites) | pass |
| New guard e2e on the memory tier (`guard-capability-order.e2e-spec.ts`) | 3 of 11 failed | pass |

The tests that passed on `main` are the positive controls (an active member is issued; no issuer: the event is written; and so on). Every denial test has its control in the same test: the other logins are refused while the issuer succeeds; each refusal is followed by an issue for an active member; a PUBLIC-grant detector is shown to see a PUBLIC grant; the transaction count is measured against the pool's own connection count; the source scan for the exemption first finds a name that is there.

**Injected defects** (each applied alone to the committed tree, the listed suites run, the file restored; the harness checks `git status` is clean after each and first checks that every suite is green unmutated):

| Defect | Result |
|---|---|
| M-A1 | the guard asks for the capability AFTER the membership lookup | red: req: 10 failed; e2e: 3 failed (`a removed person, with a working issuer: 403, one refused row in the issuance log, and NO `) |
| M-A2 | the guard's membership lookup is exempt from the count again (the old flag, under new names so the source scan cannot see it) | red: req: 5 failed (`control: with the issuer down the same lookup runs WITHOUT a capability, is counted with i`) |
| M-A2b | the exemption is brought back by name (isAdmitting exported again) | red: unit: 1 failed; req: 1 failed (`no longer exports a way to mark a lookup as admission, so every transaction can be counted`) |
| M-A3a | the NEW function reads the membership without status = active (the inner function still re-checks) | red: cap: 1 failed (`logs a person with no active membership at version 0 (no membership has one), and an activ`) |
| M-A3b | the function it delegates to ignores membership status | red: cap: 1 failed (`refuses a removed person, mints nothing, and logs the refusal`) |
| M-A4 | the function it delegates to ignores a suspended organization | red: cap: 3 failed (`logs a person with no active membership at version 0 (no membership has one), and an activ`) |
| M-A5 | the new issue function is granted to telesphoros_app | red: cap: 2 failed; prov: 7 failed (`is a definer owned by the capability owner, with a fixed search path, and EXECUTE for the `) |
| M-A6 | the new issue function returns a wrong (fixed) version | red: cap: 3 failed (`a removed person is refused for the reason of the removal, not for a missing version (and `) |
| M-A7 | app_capability_version() ignores expiry | red: cap: 2 failed (`answers nothing for a forged, oversized, expired or revoked token, a mismatching tenant se`) |
| M-A8 | app_capability_version() is left granted to PUBLIC | red: cap: 2 failed; prov: 7 failed (`EXECUTE goes to the roles that already bind through app_tenant(), and never to PUBLIC: the`) |
| M-A9 | the guard binds the version the lookup read, not the one the capability carries | red: req: 1 failed (`a move after the issuance: the write is refused at commit with 403 and leaves no row; the `) |
| M-A10 | admission refusals are never written, even with no issuer or a failed one | red: e2e: 7 failed; req: 9 failed (`a person the issuer refused as not current (removed, unknown) is refused 403 and writes no`) |
| M-A11 | any absent capability is treated as a recorded refusal | red: e2e: 7 failed; req: 9 failed (`a person the issuer refused as not current (removed, unknown) is refused 403 and writes no`) |
| M-A12 | the guard still sends a membership version to the issuer | red: e2e: 1 failed; req: 2 failed (`the issuer is asked before the membership is read, once, with the access token and the req`) |
| M-A13 | withTenant calls that name an actor skip the binding and the count | red: req: 10 failed (`every withTenant call in one request sets the same capability, including organization work`) |
| M-A14 | the down migration forgets app_capability_version | red: cap: 2 failed; mig: 1 failed (`0028 refuses while the issuance log holds a record, reverts with the explicit setting, and`) |
| M-A15 | the privilege facts allow the app login to call the new issue function | red: prov: 7 failed (`passes the privilege checks (the 0031 entries are checked only once its functions exist), `) |
| M-A16 | the issuer core accepts an issuance with no usable version | red: unit: 6 failed (`an issued answer with a membership version of -1 is a failure, not a capability`) |
| M-A17 | the issuer server still accepts a caller-supplied membershipVersion | red: unit: 2 failed; req: 1 failed (`a membershipVersion from a caller (the database reads it; a client that still sends one is`) |
| M-A18 | token-revoked is no longer recorded when the issuer issued | red: e2e: 1 failed; req: 2 failed (`a revoked token is still recorded when the issuer issued: that person holds a valid capabi`) |
| L-A1 | lint: the earlier-REVOKE evidence is always accepted | red: lint: 8 failed (`still refuses it when the earlier REVOKE was from a different role`) |
| L-A2 | lint: any earlier mention counts as evidence, whatever the verb | red: lint: 5 failed (`still refuses it when the earlier REVOKE was from a different role`) |
| L-A3 | lint: the earlier events are not matched by privilege | red: lint: 1 failed (`still refuses it when the earlier REVOKE was of a different privilege`) |

M-A3a (the new function reads the membership without `status = 'active'`) first **survived** and was then pinned: the inner function re-checks the status, so the only observable change is the version in the log row (0 versus the removed row's version). The refusal test now asserts the logged version, and the mutant is red. M-A2 first used a stack-based exemption that never fired (async frames); it was replaced by the real flag under new names. Both were found by the first run of this table.

**Local loop** on `0b70bdd` = `main` `0a6ffa6` (#225, #226 and P2 option B #227 merged) plus this branch (macOS; Node 22.22.0; PostgreSQL 16.15 with scram-sha-256 on an owned cluster; moto for S3; PG16 tools first on `PATH`, `LC_ALL=en_US.UTF-8`; ports chosen after grepping the suite): `pnpm install --frozen-lockfile`, `typecheck`, `lint`, `build` pass; root `pnpm test` pass (backend without the database: 116 suites passed, 11 skipped; 1787 tests passed); `knowledge:verify --production` ok; `test:infra` 134 of 134; `test:ci-config` 172 of 172; backend tier 1 (database and S3 set) 177 suites passed, 11 skipped, 2678 tests passed; tier 2 (`TEST_STORAGE=postgres`) 186 passed, 2 skipped, 2913 tests; fixture lifecycle 6 of 6; tier 3 (PostgreSQL and S3) 188 of 188, 2933 tests passed, 1 skipped; worker 169 of 169; `gitleaks git --log-opts=HEAD` (8.30.1): 355 commits scanned, no leaks. The first loop on the merged tree found two specs that assumed their own migration was the newest (P2's `agentic-identity.pg-spec` applied everything and expected `['0030']`; my provision-logins spec reverted two steps); both are fixed in `0b70bdd`. The injected-defect table below was run on the pre-merge tree (migration then numbered 0030) with the same code and tests; the merge and renumber moved no code.

**Not run here:** hosted CI; `test:image` (needs Docker); `tofu test` and anything against AWS; the browser tests; `test:ig` (Java 21); an RDS or staging instance; a non-superuser migrator on RDS (the `ledger-migration` spec applies and reverts 0031 as a non-superuser login, and now asserts `telesphoros_capability` holds no schema `CREATE` afterwards; RDS itself is unverified).

**Risks, stated plainly.**
1. Every authenticated request now reaches the issuer before the membership check, so a removed person's still-valid token costs one refused issuance per request. `IpRateLimitGuard` runs first; `PersonRateLimitGuard` runs after `AuthGuard`. `capability_issuance_log` is append-only and refused rows are not limited. Volume is **unmeasured**.
2. D1=(i) as written ("the API stops writing `access.refused` for admission refusals") would lose those records while no issuer is deployed (the default). It is therefore conditional on the issuer having refused. If Jan wants it unconditional, that is one line and a loss of audit until an issuer runs.
3. The issuer's HTTP body no longer takes `membershipVersion` (a client that sends one gets `400`) and the answer gains it. Nothing is deployed and the API has no HTTP client yet, so there is no mixed fleet; the order if there were is in the transport doc, addendum 3.
4. The version read and the issuance are two statements: a membership that moves between them is refused (`membership-not-current`), failing closed. A move between the issuance and the lookup binds the older version, so writes are refused at commit and reads proceed.
5. **Migration number:** this was `0030` until P2 option B (#227) merged with `0030_agentic_synthetic_identity`; the branch was merged with `main` and renumbered `0031` (two file renames and the text above; the specs name the migration, so nothing else changed). The two touch different objects (P2 calls `app_tenant()`, `app_actor()` and `membership_assert_current`, none of what 0031 adds).
6. The six-argument function stays callable by the issuer. Removing it is a `breaking` change for a later migration.

## Slice 3 PR B: tenant binding policies (migration 0032, mode dual), mutant controls, 2026-10-21 (local, not pushed)

Each mutant was applied to `apps/backend/migrations/0032_tenant_binding_policies.up.sql` alone, the spec run, and the file restored from commit `1997b94` (`git checkout`; the tree was clean afterwards). Scratch cluster, same as the tier runs. Result = pass/fail of the spec run; "red" means a named test failed.

| Mutant | What it breaks | Spec run | Caught by |
|---|---|---|---|
| M6 | `job_enqueue` reads the actor setting, not the capability | tenant-binding: 1 failed, 8 passed | the requested_by test (T021) |
| M9 | `membership_assert_current` skips the capability check (FR-007) | tenant-binding: before this PR's new test 9/9 green (a gap, see below); after the new stale-capability test: 1 failed, 9 passed | the stale-capability test |
| M11 | the internal binding granted to `telesphoros_app` | tenant-binding: 1 failed, 9 passed | the EXECUTE-grant test |
| M12 | `uploads_sweep` does not restore `app.capability` | tenant-binding: 1 failed, 9 passed | the restore test |
| M14 | mode left at `guc` | tenant-binding: 10/10 green (no mode assertion in this spec); tenant-capability: 2 failed | the "binding mode is dual" test (in tenant-capability) |
| M1 | the `patients` policy left on the setting | tenant-binding: migration refused at its own postcondition ("1 policies still read the setting, 47 read app_tenant()") | the migration postcondition, before T020 runs |

**Gap found and closed:** before the stale-capability test was added, M9 was green. The membership table check already compares the sub and version, so the capability check only matters for a capability issued at an older version. The test "a capability issued before a membership change is refused after it" covers that case.

**Not a test failure, but noted:** M1 is caught by the migration's postcondition, not by T020. T020 has no independent control for a single policy left on the setting while the postcondition is present.

**Not run:** M2 (ledger policy reverted), M17 (down migration omits a policy), and the M-A mutants for migration 0031.

**Follow-up runs (same method):**
- M2: a ledger policy left out of the up loop. The loop's own count assertion refuses the migration ("changed 47 policies, expected 48") before any policy is altered, so T020 is not the control that fires.
- M17: the down loop omits the `patients` policy. The tenant-capability revert tests fail (2 of 56: the 0031 revert snapshot and the 0028 revert with the issuance log). The up path is unaffected.

**M-A8 (0031, shipped migration, mutated for one run and restored from commit):** `app_capability_version()` granted to PUBLIC. tenant-capability: 2 failed (the "EXECUTE goes to the roles that bind through app_tenant(), never PUBLIC" test and the 0031 revert snapshot).

**Vacuity guard (T020):** added to tenant-binding. The catalog's 29 tenant-policy tables must equal the three seeded tables plus the 26 listed as unseeded on purpose; each unseeded table is covered by its domain spec. This is an explicit list, not a proof that those 26 tables are exercised by this spec.
