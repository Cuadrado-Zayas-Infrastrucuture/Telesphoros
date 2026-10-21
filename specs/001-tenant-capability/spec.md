# Feature Specification: Tenant binding the application login cannot forge (DATA-01)

**Feature Branch**: `docs/data01-tenant-capability-spec` (spec only; each implementation slice gets its own branch off `main`)

**Created**: 2026-10-19

**Status**: Draft. The founder decided D1–D9 on 2026-10-19 by accepting the recommendations (plan.md, "Founder decisions"). **No slice is approved for implementation yet.**

**Input**: Security audit 2026-10-19, finding DATA-01 (High, CVSS 4.0 7.4, CWE-653). The founder decided on 2026-10-19: *"Accept option A for synthetic-only staging (I accept the stated risk), and plan option B before any real data."* On the same day the founder approved extending option B from P2 to every row-level-security read and every definer function (this spec).

**Builds on**: `docs/design/plans/agentic-session-capability.md` (option B for P2 only). It was written on the founder's local branch `chore/agentic-session-capability-plan` (`57e1b3f`) and is published unchanged in PR #192 (decision D9). That plan's mechanism (a hashed, issuer-minted capability row) and its evidence for decisions D1–D4 are reused here. Its non-goal "Row-level security reads stay GUC-based" is **superseded** by this spec. Line numbers below cite `main` `ac7bc72`.

## The problem

Every tenant boundary in the database decides *which organization* and *which person* from two session settings:

- **Policies.** 74 reads of `current_setting('app.current_tenant_id', true)` in RLS policies and functions across the up migrations 0002–0026 (a grep count; some are in definitions later replaced, and task T001 replaces it with a catalog count), for example `0003_tenancy.up.sql:81-88`, `0017_membership.up.sql:41`, `0023_jobs.up.sql:129-131` and `0026_browser_sessions.up.sql:59-66`.
- **Policies for roles other than the application.** The slice 1 catalog inventory (`docs/verification/tenant-capability.md`, PR #193) counts 48 policies that read the setting: 30 for `telesphoros_app`, 2 shared with `telesphoros_worker`, 12 for `telesphoros_ledger`, 2 for `telesphoros_redactor`, 2 for `telesphoros_jobs` and 2 with no `TO` clause (PUBLIC). The ledger triggers and `ledger_append` run as `telesphoros_ledger` **inside the application's transaction**, so a forged setting reaches those policies too.
- **Definer functions that take identity from the caller.** SECURITY DEFINER functions read the same settings:
  - `ledger_append_internal`: `0005:151-152`, redefined `0011:193`
  - `membership_assert_current`: `0017:77`
  - `security_event_append`: `0018:74-75`, redefined `0022:17-18`
  - `member_admin_context` (used by the four member-administration functions): `0019:112-113`
  - the `tenant_memberships_audit` trigger (invoker; reads the actor to tell a person from an operator): `0019:211`
  - the `patient_identifiers_guard` trigger (invoker; reads the actor on application writes): `0020:41`
  - `job_enqueue`: `0023:140-141`
  - `outbox_append`: `0024:93`
- **The audit writer.** `security_audit_record` (`0016:37-45`) does not read them at all. It takes the tenant and the actor as **plain parameters** from the application.

The only production setter is `Database.withTenant` (`apps/backend/src/db/database.ts:81-82`), after the API has verified a Cognito token. The database cannot tell those values from forged ones. Probe P7 (2026-10-19, PostgreSQL 16, login `telesphoros_test_app`, `rolsuper=false`, `rolbypassrls=false`) showed it:

- Without the setting, the login sees **0** patients.
- After `set_config('app.current_tenant_id', …, true)` it reads **4** rows of org-alpha and **1** row of org-beta.

**Threat.** An attacker runs code or SQL as the application login. That covers a compromised API process: a dependency, an RCE, or a debugging session left open. It also covers a stolen `telesphoros_api` connection string. That attacker can read and change every organization's records, and can write audit and security events in anyone's name. RLS limits query *mistakes*; it does not limit a compromised application. SQL injection is not the path: 0 of 304 query sites are injectable.

**Rule (from the P2 proposal):** the proof of identity must be created by a principal the application login cannot imitate.

## User Scenarios & Testing *(mandatory)*

The "users" here are the security properties the founder needs before real PHI. Each story is one slice, and each slice can be shipped and tested on its own.

### User Story 1 - A forged tenant setting reads nothing (Priority: P1)

An attacker holding only the application login sets `app.current_tenant_id` to another organization and queries any tenant table. The attacker gets no rows, because the database binds rows to the tenant of a valid capability, not to a setting.

**Why this priority**: This is DATA-01 itself: confidentiality of every organization's records. It is the hard gate before real data.

**Independent Test**: In the hostile-login pg-spec (FR-012), the real application login with a foreign tenant setting and no capability reads 0 rows from every RLS-protected table. With a valid capability for its own organization it reads exactly that organization's rows (the positive control).

**Acceptance Scenarios**:

1. **Given** org-alpha has 4 synthetic patients and org-beta has 1, and enforcement is on, **When** the application login sets `app.current_tenant_id = 'org-beta'` with no capability and runs `SELECT count(*) FROM patients`, **Then** the result is 0.
2. **Given** the same data, **When** the application login presents a valid capability issued for an org-alpha member, **Then** it sees exactly the 4 org-alpha patients, whatever `app.current_tenant_id` is set to.
3. **Given** a valid org-alpha capability, **When** the application login also sets `app.current_tenant_id = 'org-beta'`, **Then** it sees 0 rows: a mismatch fails closed, it does not pick a winner.
4. **Given** a capability that has expired, been revoked, or was never issued (32 random bytes), **When** it is presented, **Then** it reads 0 rows.

---

### User Story 2 - Definer functions and audit writers take identity only from the capability (Priority: P1)

An attacker holding only the application login calls an app-callable SECURITY DEFINER function (enqueue a job, append a ledger or outbox event, record a security or audit event, administer members) for another organization or in another person's name. The call is refused, or it records the capability's identity, never the claimed one.

**Why this priority**: Without this, a forged setting still writes into another organization, or forges the audit trail that the audit-trail findings (API-01, INF-06) depend on.

**Independent Test**: The same pg-spec enumerates every function the application login can EXECUTE that is `prosecdef`, from the catalog. With no valid capability, each one is refused with SQLSTATE `42501`; `membership_assert_current` returns `false`. With a capability, each one succeeds and stores the capability's tenant and person.

**Acceptance Scenarios**:

1. **Given** enforcement is on and no capability is set, **When** the application login calls `job_enqueue`, `outbox_append`, `ledger_append`, `security_event_append` or any member-administration function, **Then** each raises `42501` and writes nothing.
2. **Given** a valid org-alpha capability for person `alice`, **When** the application login sets `app.current_actor = 'mallory'` and calls `job_enqueue`, **Then** the job's `requested_by` is `alice`.
3. **Given** a valid org-alpha capability for `alice`, **When** the application calls the audit writer naming tenant `org-beta` and actor `mallory`, **Then** the stored row says `org-alpha` and `alice` as verified identity. The application's claim is kept only in separate, explicitly unverified columns (decision D6).
4. **Given** no capability (an authentication that failed before any identity existed), **When** the audit writer is called, **Then** the row is stored with verified tenant and actor NULL and the claim marked unverified. Refusals are still recorded.

---

### User Story 3 - Only the issuer can mint, and only for a live membership (Priority: P1)

A capability exists only if a separate issuer login minted it after verifying the person's Cognito access token and their current membership.

**Why this priority**: The capability is worthless if the application login can mint one.

**Independent Test**: Every login except the issuer gets `42501` on the capability table and on the issue function. Issuing for a removed person, a bumped membership version or an inactive organization is refused. Positive control: issuing for an active member succeeds, and the capability is immediately usable by the application login.

**Acceptance Scenarios**:

1. **Given** the application, worker, verifier, operator or auditor login, **When** it SELECTs or INSERTs on the capability table or EXECUTEs the issue function, **Then** it gets `42501`.
2. **Given** the issuer login and a membership whose version moved since the token was verified, **When** it issues, **Then** issuance is refused and a security event is written.
3. **Given** an issued capability, **Then** the database stored only `sha256(token)`, its timestamps come from the database clock, and its lifetime is at most the value set by decision D1.

---

### User Story 4 - Rollout does not break today's behaviour or the write-time membership check (Priority: P2)

The change lands in expand → dual → enforce → contract steps. At each step the existing suites stay green and the commit-time membership check keeps working: `authorityStillCurrent` in `database.ts:105-123` calls `membership_assert_current` after the first write and holds its share lock to COMMIT.

**Why this priority**: The tenant binding sits under every query. A big-bang switch risks an outage or a silently weaker check.

**Independent Test**: In dual mode the full backend suite passes on all three tiers with the capability present, and also with it absent. The membership pg-specs (`membership.pg-spec.ts`, `session-admission.pg-spec.ts`) pass unchanged in every mode. Only an owner-only setting switches modes; the application login cannot change it.

**Acceptance Scenarios**:

1. **Given** dual mode and a request with no capability, **Then** behaviour is identical to today. The request is counted, so the switch to enforcement can be measured.
2. **Given** dual mode and a request with a capability whose tenant differs from the setting, **Then** it fails closed (0 rows, `42501` on definer calls) and is counted.
3. **Given** enforce mode and a membership removed mid-request, **When** the request writes and reaches COMMIT, **Then** it is refused exactly as today (403 and an `access.refused` event).
4. **Given** the application login, **When** it tries to change the binding mode, **Then** it gets `42501`.

---

### User Story 5 - The background worker cannot read other organizations' jobs by setting a GUC (Priority: P3)

The worker login (`telesphoros_job_worker`) reads `jobs` and `job_attempts` under the same GUC policy (`0023:129-131`). A compromised worker could set the GUC and read any organization's job rows. The worker has no person and no Cognito token. Its binding has to come from the lease it holds: `job_claim` would issue a lease-bound capability for the claimed job's tenant.

**Why this priority**: Job rows carry identifiers, not clinical content, and the worker reads everything else through definer functions that set the tenant from the job row (`0024:165`, `0024:245`). Lower exposure, but the same flaw. Whether it gates real data is decision D3.

**Independent Test**: The worker login with a foreign tenant setting and no lease capability reads 0 job rows. With the capability from its own claim it reads that job's rows only.

### Edge Cases

- **Expiry during a long transaction.** A capability that expires mid-transaction makes later statements see 0 rows. `statement_timeout` is 5 s and `idle_in_transaction_session_timeout` is 10 s (`database.ts:61-62`), so a lifetime of 60 s or more cannot expire inside a normal request. The test covers the boundary.
- **Issuer down.** The API cannot read or write tenant data, and fails closed with 503 (decision D4).
- **Pooled connection reuse.** The capability is set transaction-local, exactly like today's setting, so it does not leak to the next request. The existing `rls.pg-spec.ts:102` case is extended.
- **Actorless API work.** Work running with no request authority (`apps/backend/src/auth/authority-context.ts:49`) has no Cognito token of its own. The slice 1 inventory found only three such sites, all `asOrganizationWork` housekeeping **inside a request** (`security-events.ts:87`, `reports/intake/intake.service.ts:181`, `:208`), and no API path that reaches tenant data through the application login outside a request. They use the request's capability (FR-011). Anything found later that runs outside a request must move to the worker or to a definer function that takes the tenant from its own row. The issuer never mints from an unauthenticated claim (decision D5).
- **Operator and recovery tools.** The CLI commands run as the migrator, auditor or admin login, never the application login (slice 1 inventory). One check depends on the setting: `restore.ts:288-296` (`verifyIsolation`) runs `SET LOCAL ROLE telesphoros_app`, sets `app.current_tenant_id` and expects the tenant's rows. In `capability` mode it would see 0 and report a healthy restore as broken. It MUST change in the enforce slice (FR-016).
- **Definer functions that set the tenant themselves.** These are `ledger_record_checkpoint` (`0005:252`, `0011:84`; EXECUTE by the verifier login), `job_held` (`0024:165`) and `uploads_sweep` (`0024:245`; both EXECUTE by `telesphoros_jobs` only). They take the tenant from a row or an argument and run as owner roles the application is not a member of. Once every policy reads `app_tenant()` (FR-006), setting the old setting no longer binds them, so they bind through an internal capability instead (FR-015).
- **The raw token in logs.** The token travels as a bind parameter to `set_config`. With `log_statement = ddl` (`infrastructure/terraform/database.tf:39-41`) it is not logged, but an error log can print parameters. The token is useless after its lifetime, and the database stores only its hash.
- **Clock skew.** Issue time and expiry are both stamped by the database, never by the issuer or the API.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST provide a capability: 32 random bytes generated by the issuer and stored only as `sha256(token)` in a table that no login other than its NOLOGIN owner can read or write. Each row records tenant, person (`sub`), membership version, purpose, database-stamped `issued_at` and `expires_at`, and `revoked_at`.
- **FR-002**: A new login, `telesphoros_session_issuer`, MUST be the only principal able to mint capabilities. It is a member of NOLOGIN `telesphoros_issuer` and has EXECUTE on the issue function and nothing else. It is the **same** issuer the P2 plan introduces (one issuer, several purposes), not a second one.
- **FR-003**: The issue function MUST re-check the membership (active, same version) and the organization (active) under lock, and MUST refuse otherwise. It MUST write a security event per issuance (who, purpose, never the token).
- **FR-004**: The issuer process MUST verify the Cognito access token itself, with the same checks as `CognitoTokenVerifier` (`apps/backend/src/auth/cognito-token-verifier.ts:45-54`), before calling the issue function. It reuses that class unchanged, as P2 plan D4 recommends.
- **FR-005**: A single SECURITY DEFINER, STABLE function `app_tenant()` (with `app_actor()` beside it) MUST be the only place that turns the request's binding into a tenant or person. It reads the token from the transaction-local setting `app.capability`, hashes it and looks up an unexpired, unrevoked row. It returns NULL for no token, an unknown token, an expired token, or a token whose tenant disagrees with `app.current_tenant_id` when that is also set.
- **FR-006**: **Every** RLS policy that today compares to `current_setting('app.current_tenant_id', true)` MUST compare to `(SELECT app_tenant())`, whatever role it applies to: `telesphoros_app`, `telesphoros_worker`, `telesphoros_ledger`, `telesphoros_redactor`, `telesphoros_jobs` and PUBLIC (48 policies in the slice 1 inventory). Open policies (`USING (true)`) for the verifier, operator and jobs definer roles are unchanged. The scalar subquery makes PostgreSQL evaluate it once per statement (an InitPlan), not once per row; `query-plans.pg-spec.ts` must show this.
- **FR-007**: Every app-callable SECURITY DEFINER function MUST take its tenant and person from `app_tenant()` / `app_actor()` and MUST raise `42501` when they are NULL. `membership_assert_current` MUST take the tenant from `app_tenant()` and MUST also require its `p_sub` and `p_version` to equal the capability's. It keeps returning `false` rather than raising, so `authorityStillCurrent` is unchanged. The same applies to everything reached from those functions or from application writes that reads the actor or tenant: `ledger_append_internal`, the invoker helper `member_admin_context`, and the triggers `tenant_memberships_audit` and `patient_identifiers_guard`. These MUST use `app_actor()` / `app_tenant()`.
- **FR-007 note for the P2 entry points (2026-10-21)**: `agentic_synthetic_admit`, `_read` and `_cancel` (migration 0030) take their caller from the capability through `agentic_synthetic_identity()`, which requires `app.capability` to be set in every binding mode, and answer a missing or invalid capability with their existing `NOT_AUTHORIZED` refusal instead of raising `42501` (their contract and tests expect a refusal that reveals nothing). `agentic_synthetic_member_current` (worker side) still writes the tenant setting and is the one P2 function the FR-010 lint will list until it binds through FR-015 or slice 7.
- **FR-008**: The audit writer MUST store the verified tenant and person from the capability. Whatever the application claims MUST go only into columns explicitly named as unverified (decision D6). Today's signature keeps working until the contract slice.
- **FR-009**: A binding mode, `guc`, `dual` or `capability`, MUST live in a table owned by the capability owner. Only a migration may change it; the application login has no grant on it. It must not be a GUC, because the application can set any GUC. `app_tenant()` falls back to the old setting only in `guc` and `dual`.
- **FR-010**: Once the mode is `capability`, a catalog test MUST fail when **any** policy, for any role, still reads `app.current_tenant_id`, or when any function in `public` reads `app.current_tenant_id` or `app.current_actor`. The only exceptions are `app_tenant()`/`app_actor()` themselves. It MUST also fail when any function other than the named class (b) functions calls the internal binding (FR-015).
- **FR-011**: The API MUST obtain **one capability per request**, before the request's first `BEGIN`, and every `withTenant` call in that request MUST reuse it: there are 46 call sites, and the organization-work calls run after a removal, when a fresh issuance would be refused. It sets `app.capability` transaction-locally beside the existing settings. Work that outlives the capability's lifetime fails closed. A failure to obtain one is a 503 in `capability` mode. The capability-less count MUST be emitted in `dual` mode.
- **FR-012**: A hostile-login pg-spec MUST exist and run in the PostgreSQL tiers. It connects as a **real** login that is a member of `telesphoros_app` (not `SET ROLE` from a superuser) and proves US1–US3. Each refusal has a positive control in the same run. Each guard is proved by a mutant that turns the spec red (see plan, "Verification").
- **FR-013**: Expired capability rows MUST be removed by a bounded sweep. This is a worker job, using the existing `uploads_sweep` pattern (`0024:234`), so the table does not grow without bound.
- **FR-014**: Each migration from 0028 on MUST carry an honest `-- compat:` label (`apps/backend/src/db/migration-lint.ts`). Policy rewrites and function redefinitions are `breaking`.
- **FR-015**: An owner-only internal binding MUST exist for the class (b) functions: `tenant_capability_bind_internal(p_tenant)`, SECURITY DEFINER, owned by the capability owner, EXECUTE granted only to `telesphoros_ledger` and `telesphoros_jobs` (roles the application is not a member of), and called only from those functions' own bodies (FR-010). It mints a database-generated, transaction-scoped capability for the given tenant, sets `app.capability` to it, and the caller restores the previous value before it returns, so nothing is left in the caller's transaction.
- **FR-016**: Every tool that today proves isolation by setting `app.current_tenant_id` (the inventory found `restore.ts` `verifyIsolation`) MUST prove it the new way in the enforce slice: the setting alone sees 0 rows, and a capability sees the expected count.

### Key Entities

- **Capability**: a short-lived, hashed proof that a verified person in a live membership is acting for one organization. Owned by the issuer side; consumed (read) by `app_tenant()`. Its fields are listed in FR-001.
- **Issuer**: a separate process and database login. It verifies the Cognito access token and mints capabilities. It never reads tenant data.
- **Binding mode**: one owner-only row, `guc`, `dual` or `capability`. It controls whether the old setting is still honoured.
- **Lease capability** (US5, if D3 says so): minted by `job_claim` for the claimed job's tenant and bound to its lease.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In `capability` mode the hostile-login pg-spec passes on CI's PostgreSQL tiers. The application login with a foreign tenant and no capability reads 0 rows from **every** RLS-protected table, and every app-callable definer function refuses it. The list of tables and functions is enumerated from the catalog, not hand-listed, and the positive control reads the expected hand-written counts.
- **SC-002**: After the contract slice, a catalog query finds 0 policies (any role) and 0 functions (other than `app_tenant()`/`app_actor()`) that read `app.current_tenant_id` or `app.current_actor`, out of the 48 policies and the class (a) functions counted by the slice 1 inventory.
- **SC-003**: Each mutant listed in the plan turns the spec red, and the red output is recorded in `docs/verification/`.
- **SC-004**: Added request latency from the issuer round trip is measured on synthetic staging. It is reported as p50/p95 with sample size and window, against a budget the founder sets (decision D4). It is not asserted in advance.
- **SC-005**: Before the switch to `capability`, the capability-less count in `dual` mode is 0 over the window decision D7 sets, with its denominator (total requests) reported.
- **SC-006**: Every issuance has exactly one security event, and no event or log line contains a raw token. A test reads the rows back.

## Assumptions

- PostgreSQL ≥ 13 (RDS runs 16), so `sha256(bytea)` is built in. No `pgcrypto` is needed, and the repo uses none today.
- Cognito access tokens live 15 minutes with revocation on (`infrastructure/terraform/cognito.tf:103-112`). That bounds how long a compromised API process can relay a real user's token to the issuer.
- Requests run at READ COMMITTED, so a capability committed by the issuer before the API's `BEGIN` is visible to every statement in the request.
- P2 (local branch `feat/durable-synthetic-local`, migration 0028, not merged) will merge first or rebase onto this work. Migration numbers are assigned when each slice is written.

## Alternatives considered

| Option | Why not chosen |
|---|---|
| **Per-tenant roles selected with `SET ROLE`** (named in the audit) | `SET ROLE` requires membership in the target role, so the application login would have to be a member of **every** tenant role. A compromised process could then `SET ROLE` to any of them, which is the same exposure as today. It also needs one role per organization in the catalog and in `provision-logins`. |
| **Stateless HMAC capability** (key in an owner-only table, verified in `app_tenant()`) | It adds the `pgcrypto` extension and a signing key with its own custody, rotation and overlap window. It cannot be revoked before expiry. Its only gain is no INSERT per request; if issuer write load is measured as a problem, it is a drop-in change behind `app_tenant()`. |
| **Verify the Cognito JWT inside PostgreSQL** | RS256 verification is not available in `pgcrypto`; on RDS it would need an unsupported extension (P2 proposal). |
| **Reuse `browser_sessions`** | The application login can INSERT and SELECT it (`0026:68-69`), so it can mint a session for anyone. |
| **Keep option A and protect the credential** | It does not stop a compromised process. It is accepted only for synthetic-only staging (founder, 2026-10-19). |

## Key custody and rotation

The chosen design has **no signing key**. The trust anchors are:

1. **The issuer login's credential.** Created by `provision-logins` as a fifth login (`apps/backend/src/db/provision-logins.ts:38` lists four), stored in its own secret and readable only by the issuer's own execution role and task role (P2 plan D1, first condition). It is rotated with `provision-logins`' existing `rotated` action (`provision-logins.ts:72`). Rotation needs a new issuer task, because ECS does not refresh an injected secret (P2 plan D1). It is never used by a person.
2. **Cognito's signing keys.** These are managed by AWS and read through JWKS by the issuer, as the API does today.

The **token** is a bearer secret for at most its lifetime. Only its hash is stored. Revoking one sets `revoked_at`; revoking all of a person's tokens follows from bumping their membership version, which the issue function and FR-007 already check.

**Residual risks (stated, not solved):**

- A compromised API process can relay real users' in-flight access tokens to the issuer for up to 15 minutes. It can act only for those users, only in their own organization, and every issuance is logged and rate-limited (P2 plan D3).
- A stolen **issuer** credential can mint for anyone. It is single-purpose, held in a separate secret and used by no person.
- The RDS master user, or anyone else with superuser, bypasses all of this, as with every control in the database.
