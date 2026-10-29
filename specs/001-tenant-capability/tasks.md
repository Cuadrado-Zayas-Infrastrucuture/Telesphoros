# Tasks: Tenant binding the application login cannot forge (DATA-01)

**Input**: [spec.md](spec.md), [plan.md](plan.md)

**Prerequisites**: plan.md **approved by the founder**, plus the decisions each phase names. The decisions D1–D9 were made on 2026-10-19; plan.md is not yet approved, so `/speckit-implement` must not run against this file.

**Tests**: Required by the spec (FR-012, SC-001, SC-003). In each phase the test tasks come first, and they must fail before the implementation lands (or, in Phase 2, assert today's open state).

**Organization**: One phase per slice in plan.md, and one draft PR per phase off `main`, never stacked. `[P]` marks tasks that can run in parallel within a phase (different files, no dependency).

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Inventory (part of slice 1's PR; read-only work)

**Purpose**: Replace counts from grep with counts from the catalog before anything is changed.

- [x] T001 [P] Query `pg_policies` on a migrated test database and list every policy, with its roles, that reads `app.current_tenant_id`, `app.current_actor` or `app.current_owner_id`. Record it in `docs/verification/tenant-capability.md`
- [x] T002 [P] Query `pg_proc` for every `prosecdef` function and every trigger function, recording for each: owner, the grantees with `has_function_privilege`, and whether `prosrc` reads or sets those settings. Classify each: (a) identity from the caller, which must change; (b) sets the tenant itself from a row or argument, which must set before reading; (c) does not care. Same record
- [x] T003 [P] List every `withTenant` call site in `apps/backend/src` with the request authority it runs under; the nine repositories are listed in plan.md
- [x] T004 [P] Find API work that runs with `currentRequestAuthority()` undefined (decision D5), and the operator and recovery tools that set the tenant themselves (`apps/backend/src/db/restore.ts:292`, jobs CLI, operator commands). Name each one's owner and planned fate
- [x] T005 Spot-check two items from each list by reading the source by hand, so the inventory itself is tested

**Checkpoint**: The inventory is reviewed by the founder before slice 1's migration is written. **Done 2026-10-19 in PR #193** (`docs/verification/tenant-capability.md`). Its four findings are applied to spec, plan and these tasks: every tenant-setting policy for every role (FR-006, FR-010), the two actor-reading triggers (FR-007), one capability per request (FR-011), and `restore.ts` `verifyIsolation` (FR-016). Finding 1 also adds the internal binding for the class (b) functions (FR-015).

## Phase 2: Slice 1, capability schema, inert (US3) — needs D1, D2

### Tests first

- [ ] T006 [US3] Create `apps/backend/test/db/tenant-capability.pg-spec.ts`. Connect as a **real** login that is a member of `telesphoros_app`, and assert `rolsuper=false` and `rolbypassrls=false`. Seed synthetic org-alpha with 4 patients and org-beta with 1
- [ ] T007 [US1] In the same spec, assert the **open** state on purpose: in `guc` mode, a foreign `app.current_tenant_id` with no capability still reads org-beta's 1 row ("DATA-01 open"). Phase 6 inverts this, so the later green cannot be vacuous
- [ ] T008 [US3] Cases: every login except the issuer gets `42501` on the capability table, the mode table and the issue function. The issuer issues for an active member (positive control). Issuing for a removed person, a bumped version or an inactive organization is refused and writes a security event. `expires_at - issued_at` equals the D1 lifetime, stamped by the database
- [ ] T009 [P] [US3] `provision-logins.pg-spec.ts`: the fifth login is a member of exactly `telesphoros_issuer`, and a weakened copy (also a member of `telesphoros_app`) is reported

### Implementation

- [ ] T010 [US3] Migration `00NN_tenant_capability.{up,down}.sql` (`-- compat: expand`): NOLOGIN `telesphoros_capability` and `telesphoros_issuer`; `tenant_capabilities` (FR-001) and `tenant_binding_mode` (one row, `guc`); `app_tenant()`/`app_actor()` per the plan sketch; `tenant_capability_issue` with the P2 plan D3 rate limits; a sweep job type (FR-013). Down drops all of it
- [ ] T011 [US3] `apps/backend/src/db/provision-logins.ts`: add `telesphoros_session_issuer` and its secret. If P2's slice landed first, reuse its login instead (FR-002)
- [ ] T012 Run all three backend tiers and the migrations catalog-snapshot spec, then record the results

## Phase 3: Slice 2, issuer process and the API presenting capabilities (US1, US2 plumbing) — needs D2

### Tests first

- [ ] T013 [P] [US3] Issuer verifier tests reuse the existing `CognitoTokenVerifier` fixtures: every case the API rejects, the issuer rejects too
- [ ] T014 [P] [US3] An issuance writes one security event that contains no token. The test reads the row back and greps the logs (SC-006)
- [ ] T015 [US4] `database.pg-spec.ts`: `withTenant` sets `app.capability` transaction-locally, and the next transaction on the same pooled client does not see it. A missing capability in `guc` mode increments the counter and the request proceeds

### Implementation

- [x] T016 [US3] `apps/backend/src/issuer/` as a second bundled entry point in the API image (plan, "Structure Decision"), importing `CognitoTokenVerifier` unchanged. The core was slice 2; the process entry (`main.ts`, plain `node:http`, compiled by the existing backend build) is PR A
- [x] T017 [US4] Obtain the capability **once per request** and keep it in the request's `AsyncLocalStorage` slot (`apps/backend/src/auth/authority-context.ts`). `asOrganizationWork` keeps the capability while dropping the authority. `apps/backend/src/db/database.ts` sets it after `BEGIN` on every `withTenant` call and emits the capability-less count. `authorityStillCurrent` stays unchanged. Built in slice 2 (`18c504f`: `RequestCapabilities`, called from `AuthGuard`); it was only never ticked
- [x] T018 The internal transport and caller authentication between the API and the issuer, per P2 plan D1's second condition. Document the cost before writing it. Cost and decision: the transport plan and its addendum (ECS Service Connect, security-group source plus TLS, no shared secret). The client is `apps/backend/src/issuer/issuer-http-client.ts` selected by `ISSUER_URL` (PR B, fourth addendum); the API joins the namespace as a client and receives `ISSUER_URL` in `api-compute.tf`, both only while `enable_issuer` is on. **Written, never applied**: whether the API container resolves and reaches the issuer through Service Connect is unverified

## Phase 3b: Slice 2b, issuer Terraform, written and never applied — **starts only after PR 189 merges**

- [x] T019 `infrastructure/terraform/issuer.tf`: the task, its own execution role and task role, its own secret readable only by those roles, and alarms. Guard tests with weakened-copy controls in `pnpm test:infra`. **Written, never applied.** Entry point and caller check settled in the addendum to `docs/design/plans/tenant-capability-issuer-transport.md`. The issuer entry (`dist/issuer/main.js`, no image change) is PR A (second addendum to that document). The provisioning task's `PROVISION_SECRET_ISSUER` wiring (the environment line, and the provisioning task role's fifth secret, no execution role) is done in the provisioning follow-up (PR C, `api-compute.tf`). The API client, `ISSUER_URL` and the API's namespace join are PR B (fourth addendum to that document). Still open: applying anything, and the measured D4 budget

## Phase 4: Slice 3, policies and definer functions read `app_tenant()` (US1, US2, US4) — needs D5

### Tests first

- [ ] T020 [US1] Enumerate every RLS table and **every tenant-setting policy, for every role** (48 in the inventory) from `pg_policies`. Include a forged setting plus an app write that fires a ledger trigger or calls `ledger_append`, so a `telesphoros_ledger` policy is exercised. In `dual` mode with a valid capability: own counts are correct and a foreign setting reads 0 rows (the mismatch fails closed). With no capability: today's behaviour
- [ ] T021 [US2] Enumerate every app-callable `prosecdef` function from the catalog. The spec fails if one exists that its expectation table does not name. With a capability, `job_enqueue` stores `requested_by` from the capability even when `app.current_actor` says otherwise, and so do the `patient_identifiers_guard` and `tenant_memberships_audit` triggers
- [ ] T022 [US4] `membership.pg-spec.ts` and `session-admission.pg-spec.ts` pass unchanged; a membership removed mid-request is still refused at COMMIT
- [ ] T023 `query-plans.pg-spec.ts`: `app_tenant()` appears in an InitPlan, not per row, for the patients, reports and recommendations queries

### Implementation

- [ ] T024 [US1] Migration `00NN_tenant_binding_policies.{up,down}.sql` (`-- compat: breaking`): recreate **all 48** policies from T001, every role and PUBLIC included, with `(SELECT app_tenant())`. Recreate each class (a) function from T002, together with `ledger_append_internal`, `member_admin_context` and the two triggers, to read `app_tenant()`/`app_actor()` and raise `42501` on NULL. Add `tenant_capability_bind_internal` (FR-015) and switch `ledger_record_checkpoint`, `job_held` and `uploads_sweep` to it, restoring `app.capability` before they return. `membership_assert_current` also checks `p_sub` and `p_version` against the capability. Set the mode to `dual`
- [ ] T025 Add the FR-010 catalog lint in warn-only form. It covers every policy for any role, every function body in `public`, and the callers of the internal binding, which may be only the three named class (b) functions
- [ ] T026 Confirm that nothing reaches tenant data through the application login outside a request (T004 found none), and that the three `asOrganizationWork` sites succeed with the request's capability after the person is removed mid-request (D5)

## Phase 5: Slice 4, the audit writer stores verified identity (US2) — needs D6

- [ ] T027 [US2] Test first: under alice's org-alpha capability, calling the writer with org-beta/mallory stores verified org-alpha/alice and keeps the claim only in the unverified columns. With no capability, the verified fields are NULL and the row is still written
- [ ] T028 [US2] Migration: add the verified and claimed columns to `security_audit_events` (`expand`). Redefine `security_audit_record` to derive identity from `app_tenant()`/`app_actor()` (`breaking`). `Database.recordSecurityEvent` (`database.ts:131-135`) is unchanged at its call sites

## Phase 6: Slice 5, enforce (US1, US2) — needs D4, D7, D8

- [ ] T029 [US1] Invert T007: in `capability` mode, a foreign setting with no capability reads 0 rows from every RLS table, and every app-callable definer function refuses (`42501`, or `false` for `membership_assert_current`). The positive controls are unchanged. Add a `restore.ts` `verifyIsolation` case: the setting alone sees 0 rows and a capability sees the expected count (FR-016)
- [ ] T030 Run each mutant from plan.md, "Verification". Record each red result, then the green result after reverting it, in `docs/verification/tenant-capability.md`
- [ ] T031 Migration `00NN_tenant_binding_enforce.{up,down}.sql` (`-- compat: breaking`): set the mode to `capability`; the down migration sets it back to `dual`. The FR-010 lint becomes failing. In the same PR, change `apps/backend/src/db/restore.ts:288-296` (`verifyIsolation`) to prove isolation with a capability (FR-016), because in `capability` mode it would otherwise report a healthy restore as broken
- [ ] T032 Report the D7 evidence before the PR is marked ready: the capability-less count, total requests and window, and the issuer's p50/p95 with sample size

### Slice 5 readiness (inventory 2026-10-29, `main` `f4f74dc`)

What still runs tenant-scoped SQL without a capability, or assumes `dual`. Each must be closed, or shown not to apply, before T031 flips the mode. Gates D4, D7 and D8 are unchanged.

- [ ] R1 `restore.ts` `verifyIsolation` (now `apps/backend/src/db/restore.ts:314-341`; T029, T031 cite the older 288-296): the "with tenant" case sets only `app.current_tenant_id` (`:330-331`) and would see 0 rows in `capability` mode. Closed by T029 and T031 (FR-016).
- [ ] R2 `agentic_synthetic_member_current` (`migrations/0029_agentic_synthetic.up.sql:519`) still writes the tenant setting on the worker side; 0030 and `docs/verification/business-durable-synthetic.md:219` say slice 5 must not flip before it moves. Not yet a task here: needs one.
- [ ] R3 The evaluation worker acts under a capability only when `EVALUATION_WORKER_ISSUER_URL` and its key are set (`apps/backend/src/config/env.ts:142`, spec 012); no Terraform sets them. Needed before D7's window can start.
- [ ] R4 API requests carry a capability only when the issuer is deployed: `enable_issuer` defaults to `false` (`infrastructure/terraform/issuer.tf:13`). D7's window starts only once it is on in synthetic staging.
- [ ] R5 The ai-service durable store calls an injected `withTenant` (`apps/ai-service/durable/postgres.ts:44`); whether that binds a capability is not determined. Find out before T031.
- [ ] R6 Specs that pin `dual`: `apps/backend/test/db/tenant-capability.pg-spec.ts:128` asserts the mode is `dual`, and `:293-300`, `:526-532` restore `dual` after switching. T031's PR updates them with the flip.

Paths checked and needing no capability (they bind the organization from the row or read no setting): the upload sweep, `jobs-cli`, the ledger monitor and verifier, the outbox relay and job claim and heartbeat (`docs/verification/tenant-capability.md`, class (c)). The security-event writer accepts a recently expired capability since spec 015 (0059).

## Phase 7: Slice 6, contract — separately approved

- [ ] T033 Remove the `guc`/`dual` fallback from `app_tenant()`, the old function overloads and, if nothing still needs it, the `app.current_tenant_id` write in `withTenant`. SC-002's catalog query returns 0

## Phase 8: Slice 7, worker lease capability (US5) — only if D3 makes it a gate

- [ ] T034 [US5] Test first: the worker login with a foreign setting and no lease capability reads 0 job rows; with its own claim's capability it reads that job's rows
- [ ] T035 [US5] `job_claim` mints a lease-bound capability, the worker sets it, and the `jobs`/`job_attempts` policies read `app_tenant()`

## Dependencies & Execution Order

- Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5 → Phase 6 → Phase 7, each merged before the next starts.
- Phase 3b runs any time after PR 189 merges and before Phase 6.
- Phase 8 can follow Phase 4.
- P2 plan slice 3 can run beside Phases 4–6 if both use the one capability table (plan, "Ordering with P2").
- **No real or PHI-bearing data before Phase 6 is merged and verified** (and Phase 8 too, if D3 says so).
