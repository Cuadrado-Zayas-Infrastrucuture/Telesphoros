# Implementation Plan: Tenant binding the application login cannot forge (DATA-01)

**Branch**: `docs/data01-tenant-capability-spec` (this document); one `feat/…` or `fix/…` branch per slice | **Date**: 2026-10-19 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/001-tenant-capability/spec.md`

**Status**: Decisions D0–D9 decided 2026-10-19 (see "Founder decisions"). The plan itself is **not yet approved for implementation**: no slice may start until the founder approves it.

## Summary

A separate issuer login verifies the person's Cognito access token and mints a short-lived capability. The database stores it only as a hash. One definer function, `app_tenant()` (with `app_actor()`), turns the capability the API presents into a tenant and person. Every RLS policy and every app-callable definer function reads identity from there instead of from `app.current_tenant_id` / `app.current_actor`. A binding mode that only the owner can change (`guc` → `dual` → `capability`) lets the change land without an outage. The hostile-login pg-spec is the acceptance proof.

## Technical Context

**Language/Version**: TypeScript on Node ≥ 22 (NestJS backend, worker bundle); SQL migrations on PostgreSQL 16

**Primary Dependencies**: `pg`, `jose` (already used by `CognitoTokenVerifier`), PostgreSQL built-in `sha256()`; no new extension and no new npm dependency

**Storage**: PostgreSQL; one new table (capabilities), one owner-only mode table, new columns on `security_audit_events`

**Testing**: vitest; the three backend tiers (in-memory, PostgreSQL, PostgreSQL plus S3 emulator); `*.pg-spec.ts` against a disposable PostgreSQL (`apps/backend/scripts/dev-postgres.sh`)

**Target Platform**: ECS Fargate (API, worker, the new issuer as a separate task; P2 plan D1), RDS PostgreSQL 16. **Nothing is applied in AWS by any slice.**

**Project Type**: web service (pnpm workspace: `apps/backend`, `apps/worker`)

**Performance Goals**: `app_tenant()` evaluated once per statement (InitPlan), not per row; issuer round trip p95 within a budget set by decision D4 and measured, not assumed

**Constraints**: fail closed everywhere; `statement_timeout` 5 s and `idle_in_transaction_session_timeout` 10 s are unchanged (`apps/backend/src/db/database.ts:61-62`); the migration compat lint applies from 0028

**Scale/Scope**: 74 tenant-setting reads and 7 actor-setting reads in the up migrations 0002–0026 (grep counts, including definitions later replaced; T001 takes the catalog count); 9 repositories that call `withTenant`; 10 SECURITY DEFINER functions the application role can EXECUTE (`job_enqueue`, `ledger_append`, `outbox_append`, `membership_assert_current`, `security_audit_record`, `security_event_append`, and the four member-administration functions), plus the triggers that read the actor

## Constitution Check

| Principle | How this plan meets it |
|---|---|
| I. Plan first, approved by the founder | This plan is the gate. Each slice below is its own draft PR, and none starts before approval. `/speckit-implement` runs only against `tasks.md` once this plan is approved. |
| II. Synthetic data only; secrets never leave their place | No real data; tests use org-alpha/org-beta synthetic fixtures. The issuer credential is a new secret written by `provision-logins`, never printed. The raw token is stored nowhere (hash only) and never logged (SC-006). Terraform is written, never applied. |
| III. Inbound content is untrusted | The capability token from the API is treated as untrusted input: hashed, looked up, never parsed or trusted for its contents. |
| IV. Tests earn their keep | Every refusal in the hostile-login spec has a positive control in the same run. Every guard has a mutant that must go red. Hand-written expected counts (4 and 1) are the oracle. All three tiers run. |
| V. Report outcomes faithfully | Each slice records what ran, what passed and what stayed unverified in `docs/verification/tenant-capability.md`. Staging latency and the dual-mode count are reported with their denominators. |
| Change constraints | New numbered migrations with down files, never an edit to 0001–0027. The database tier runs before each PR. `pnpm test:infra` runs for the issuer's Terraform slice. Actions stay SHA-pinned. |

**Gate result**: passes, provided slice ordering respects PR 189 (see "Not touched").

## Project Structure

### Documentation (this feature)

```text
specs/001-tenant-capability/
├── spec.md     # what and why (this PR)
├── plan.md     # this file (this PR)
└── tasks.md    # ordered tasks per slice (this PR)
docs/verification/tenant-capability.md   # created by slice 1, appended per slice
```

### Source Code (repository root)

```text
apps/backend/migrations/00NN_tenant_capability.{up,down}.sql      # slice 1 (expand)
apps/backend/migrations/00NN_tenant_binding_policies.{up,down}.sql # slice 3 (breaking)
apps/backend/migrations/00NN_audit_verified_identity.{up,down}.sql # slice 4
apps/backend/migrations/00NN_tenant_binding_enforce.{up,down}.sql  # slice 5 (breaking)
apps/backend/src/db/database.ts                 # withTenant obtains and sets the capability (slice 2)
apps/backend/src/db/provision-logins.ts         # fifth login (slice 1)
apps/backend/src/issuer/                        # second bundled entry point (slice 2)
apps/backend/test/db/tenant-capability.pg-spec.ts  # the acceptance proof (slice 1, tightened each slice)
infrastructure/terraform/issuer.tf              # slice 2b, written never applied, only after PR 189 merges
```

**Structure Decision**: The issuer is a second bundled entry point in the existing API image, as the worker is (`infrastructure/docker/api.Dockerfile:12-19`; P2 plan D4). No new package.

## Design

### Principals

| Principal | Holds | Can | Cannot |
|---|---|---|---|
| API (`telesphoros_api` ∈ `telesphoros_app`) | user requests, a capability per request | set `app.capability`; read/write its capability's organization through RLS; call app-callable definer functions | read, insert or mint capabilities; change the binding mode |
| Issuer (`telesphoros_session_issuer` ∈ NOLOGIN `telesphoros_issuer`) | its own secret | call the issue function | read any tenant table, call any app function |
| Capability owner (NOLOGIN `telesphoros_capability`) | owns the capability table, the mode table, `app_tenant()`, `app_actor()`, the issue function | everything on those objects | log in |
| Worker (`telesphoros_job_worker` ∈ `telesphoros_worker`) | unchanged until US5 | unchanged | mint person capabilities |

### Minting

1. The API verifies the bearer token and resolves membership exactly as today (`AuthGuard` → `bindRequestAuthority`).
2. Before `withTenant` opens its transaction, the API sends the issuer the access token, the purpose (`request`, or a P2 purpose) and the request id. The internal transport and its caller authentication are a P2 plan D1 condition, priced in slice 2.
3. The issuer verifies the token with `CognitoTokenVerifier`, generates 32 random bytes, and calls `tenant_capability_issue(tenant, sub, membership_version, purpose, sha256(token))`. That function runs as the owner, re-checks the membership and organization under lock, enforces the per-person/per-purpose rate limits (P2 plan D3), stamps `issued_at = clock_timestamp()` and `expires_at = issued_at + lifetime` (D1), inserts the row and writes the security event. It returns nothing secret.
4. The issuer returns the raw token to the API once.

### Verifying (inside every statement)

```sql
-- sketch, not the migration
CREATE FUNCTION app_tenant() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT c.tenant_id
    FROM public.tenant_capabilities c
   WHERE c.token_hash = sha256(convert_to(nullif(current_setting('app.capability', true), ''), 'UTF8'))
     AND c.expires_at > statement_timestamp()
     AND c.revoked_at IS NULL
     AND (nullif(current_setting('app.current_tenant_id', true), '') IS NULL
          OR current_setting('app.current_tenant_id', true) = c.tenant_id)
  UNION ALL
  SELECT nullif(current_setting('app.current_tenant_id', true), '')
    FROM public.tenant_binding_mode m
   WHERE m.mode IN ('guc', 'dual') AND nullif(current_setting('app.capability', true), '') IS NULL
  LIMIT 1
$$;
```

Policies become `USING (tenant_id = (SELECT app_tenant()))`. `statement_timestamp()` rather than `clock_timestamp()` keeps the function honestly STABLE. Its lifetime is far longer than `statement_timeout`, so the difference is immaterial. Reads keep today's admission-time semantics, so the function does not re-check membership. Writes keep the commit-time `membership_assert_current` check, now bound to the capability (FR-007).

### What `withTenant` changes (slice 2)

`withTenant(tenantId, work, { actor })` keeps its signature. Before `pool.connect()`, it obtains a capability for the current request authority. After `BEGIN`, it runs `set_config('app.capability', $1, true)` beside the two existing calls. `authorityStillCurrent` (`database.ts:105-123`) is unchanged; the stricter checks live in SQL. In `dual` mode, a missing capability is counted and the request proceeds. In `capability` mode it is a 503.

### Rollout: slices (each its own draft PR off `main`, never stacked, merged in order)

| # | Slice | Compat label | Mode after | Touches | Does not touch |
|---|---|---|---|---|---|
| 0 | **This spec** | n/a | `guc` (nothing exists) | `specs/001-tenant-capability/`, one line in `docs/STATUS.md` | everything else |
| 1 | Capability schema, inert | `expand` | `guc` | Migration: owner role, capability and mode tables, `app_tenant()`/`app_actor()`, issue function, sweep job type; `provision-logins` fifth login; hostile-login spec written **asserting the open state** ("in `guc` mode a foreign tenant still reads 1 row: DATA-01 open"), so a later green is earned | policies, definer functions, backend request path, Terraform |
| 2 | Issuer process + API presents capabilities | none (code only) | `guc` | `apps/backend/src/issuer/`, `database.ts`, metrics for capability-less requests | SQL policies, Terraform |
| 2b | Issuer Terraform, **written, never applied** | n/a | `guc` | task, own execution and task roles, own secret, alarms; guard tests in `pnpm test:infra` | **starts only after PR 189 merges**, because 189 has the same Terraform root open |
| 3 | Policies and definer functions read `app_tenant()` | `breaking` | `dual` | One migration that recreates every policy for app/worker roles and every app-callable definer function. Catalog lint FR-010 in warn-only form | audit writer, worker claim |
| 4 | Audit writer stores verified identity | `expand` (columns) then code | `dual` | `security_audit_events` gains verified/claimed columns; `security_audit_record` derives identity from the capability; `recordSecurityEvent` unchanged at its call sites | other audit findings (API-01, INF-06 are their own slices) |
| 5 | Enforce | `breaking` | `capability` | Mode row flips; hostile-login spec flips to the closed assertions; FR-010 lint becomes failing; down migration flips back to `dual` as the rollback | anything else |
| 6 | Contract | `breaking` | `capability` | Remove the `guc`/`dual` fallback from `app_tenant()`, old function overloads and the `app.current_tenant_id` write in `withTenant` (if D-decisions allow) | — |
| 7 | Worker lease capability (US5) | `breaking` | `capability` | `job_claim` mints a lease-bound capability; worker sets it | only if D3 makes it a gate |

**Ordering with P2.** P2's migration 0028 (unmerged) and P2 plan slice 1 introduce the same issuer login. Whichever lands first creates it, and the other reuses it (FR-002). P2 plan slice 3 (P2 consumes capabilities) can run beside slices 3–5 here, as long as both use the one capability table with different purposes.

**Rollback.** Slices 1, 2 and 4 are additive. Slice 3 is behaviour-neutral in `dual` mode, so rolling it back means its down migration plus the previous image. Slice 5 is undone by its down migration (mode back to `dual`), which reopens DATA-01 and is allowed only on synthetic data. Slice 6 has no rollback without a new forward migration, which is why it is last and separately approved.

### Verification (acceptance proof, built up across slices 1, 3, 4 and 5)

`apps/backend/test/db/tenant-capability.pg-spec.ts` connects as a **real login** that is a member of `telesphoros_app`, with `rolsuper=false` and `rolbypassrls=false` asserted first (as probe P7). It does not use `SET ROLE` from a superuser, which `tenancy-migration.pg-spec.ts:102-115` does for other reasons. Fixtures are synthetic org-alpha with 4 patients and org-beta with 1, with hand-written expected counts.

| Case | Expected | Control in the same run |
|---|---|---|
| Foreign `app.current_tenant_id`, no capability, every RLS table (from `pg_policies`) | 0 rows each | own capability → hand-written counts |
| Every `prosecdef` function the app login can EXECUTE (from `pg_proc` + `has_function_privilege`) | `42501`; `membership_assert_current` → `false` | own capability → succeeds, stores capability identity |
| A new app-callable definer function not in the spec's expectation table | spec fails | — |
| Forged token (32 random bytes), expired, revoked | 0 rows | valid token |
| Valid org-alpha capability + `app.current_tenant_id = org-beta` | 0 rows (mismatch) | same capability, no setting → 4 rows |
| `app.current_actor = mallory` + alice's capability → `job_enqueue` | `requested_by = alice` | — |
| Audit writer naming org-beta/mallory under alice's capability | verified org-alpha/alice, claim kept as unverified | — |
| App / worker / verifier / operator / auditor login on capability table, issue function, mode table | `42501` | issuer login issues successfully |
| Issue for removed person, bumped version, inactive organization | refused + security event | active member → issued |
| Commit-time membership check after removal mid-request | 403 path as today | unremoved member commits |
| Capability set in transaction 1 on a pooled connection | absent in transaction 2 | — |
| `EXPLAIN` of a tenant query | `app_tenant()` in an InitPlan, not per row | — |

**Mutants (each must turn the spec red; output recorded in `docs/verification/tenant-capability.md`):** one policy reverted to `current_setting(...)`; `app_tenant()` ignoring `expires_at`; `app_tenant()` ignoring the mismatch rule; the fallback left on in `capability` mode; a `SELECT` grant on the capability table to `telesphoros_app`; one definer function reading `app.current_actor`; the issue function skipping the membership version check; the issue function granted to `telesphoros_app`.

**Measured on synthetic staging (slice 2 onwards), not asserted:** issuer p50/p95 latency and error rate; capability-less requests in `dual` mode with total requests as denominator; capability table size and sweep lag.

## Founder decisions (only the founder can make these)

**Decided 2026-10-19.** The founder, replying to the D1–D9 recommendations: *"ill follow your recommendations"*. Every recommendation below is therefore the decision. That includes D8: the residual risks are accepted in writing with the stated mitigations. Two items still need a number later, and the decision fixes only how each is chosen: D4's p95 budget is set from slice 2's staging measurement, and D7's 7-day window is checked against real counts before slice 5. This approves the decisions; it does **not** approve `plan.md` for implementation (Principle I). That approval is still needed before slice 1.

| # | Decision | Decided (recommendation accepted) | Blocks |
|---|---|---|---|
| D0 | Extend option B from P2 to every RLS read and definer function, superseding the P2 plan's "reads stay GUC" non-goal | **Decided 2026-10-19: yes** (founder "ok" to the session plan) | — |
| D1 | Capability lifetime and granularity: one per request (≤ 60 s) or one per access token (cached up to the token's 15 min) | **Per request, 60 s.** Every use is then an issuer event; caching per token lets a compromised process use it for 15 min with no further trace | slice 1 |
| D2 | One issuer shared with P2, and its runtime | **Shared**, one login, purposes distinguish uses. Runtime per P2 plan D1: ECS, same image, own execution and task roles | slices 1, 2 |
| D3 | Is the worker (US5) a hard gate before real data? | **Yes, as slice 7**: lower exposure (identifiers, not clinical content), same flaw | slice 7, the real-data gate |
| D4 | Issuer outage behaviour and latency budget | **Fail closed (503)**; set the p95 budget after slice 2's staging measurement | slice 5 |
| D5 | Actorless API work (no request authority) | **Inventory first (task T004)**; move it to the worker or to row-sourced definer functions; never mint from an unauthenticated claim | slice 3 |
| D6 | Audit rows for refused or pre-authentication requests | **Verified tenant/actor NULL plus explicitly unverified claimed columns**, so refusals stay recorded without being trusted | slice 4 |
| D7 | Dual-mode window before enforcing | **7 consecutive days of 0 capability-less requests on synthetic staging**, reported with the total request count | slice 5 |
| D8 | Accept the residual risks (relay of in-flight tokens ≤ 15 min; stolen issuer credential; superuser) | Accept in writing, with the stated mitigations | slice 5 |
| D9 | The P2 plan lives only on the local, unpushed branch `chore/agentic-session-capability-plan` (`57e1b3f`). Publish it, so this spec's citation resolves for reviewers? | **Push it as its own docs PR**; this spec does not copy it. Done: PR #192, cherry-picked unchanged onto `main` | review of this PR |

## Not touched by this plan or PR

- No migration, backend, worker, frontend or test code; no CI workflow; no dependency.
- `infrastructure/terraform/`: PR 189 (evidence immutability) has it open. Slice 2b waits for 189 to merge.
- The founder's checkout at `…/2026-10-15/che/work/telesphoros-remastered` (its branch, stash and working tree), and the local branches `chore/agentic-session-capability-plan` (its commits were published in #192 by cherry-pick onto a new branch; the local branch itself is untouched) and `feat/durable-synthetic-local`.
- No AWS action, secret or deployment.

## Complexity Tracking

| Added complexity | Why needed | Simpler alternative rejected because |
|---|---|---|
| A fifth database login and a separate issuer process | The proof must come from a principal the application login cannot imitate | Any check inside the application's own login is forgeable by that login (spec, "Alternatives considered") |
| A three-state binding mode | The binding sits under every query; a single switch risks an outage and gives no measurement | A big-bang migration has no observation period and no clean rollback |
