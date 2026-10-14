# M1.5: live membership and revocation (plan)

Status: **implemented on a draft PR; the founder approved the plan and answered yes to DA-1, DA-2, DM-1 and DM-2 on 2026-10-13.** Slice M1.5 of the [repo audit and build plan](repo-audit-and-build-plan.md), closing research-audit finding **I03** (removing a person or changing a role does not revoke API authority). It is research task **T03**. DA-1 (finding **I04**, the nine read routes) ships as the separate small PR **M1.5b**, per DM-2. What was built, and where it differs from the text below, is in "Changes from this plan" at the end; evidence is in [the verification note](../../verification/m1-5-live-membership-revocation.md).

## Problem

Authority today comes from the token and nothing else. [`CognitoTokenVerifier`](../../../apps/backend/src/auth/cognito-token-verifier.ts) reads `cognito:groups` and builds a `Principal` of `{ sub, tenantId, roles }`; `AuthGuard` trusts it and `RolesGuard` checks `principal.roles`. The API verifies tokens offline. The consequences, as [auth.md](../../auth.md) already admits:

- A person removed from a tenant, disabled, or downgraded from `clinician` to `reader` keeps their old authority until their access token expires (at most 15 minutes; the verifier caps token age at one hour). Offboarding with `admin-user-global-sign-out` does not shorten that, because access tokens are not checked against Cognito.
- Nothing in our own database says who belongs to which tenant. A typo in a Cognito group name creates a separate empty tenant silently.
- If the identity provider or a token is wrong, there is no second line: the database trusts whatever tenant the application sets.
- Nine read routes carry no `@Roles`, so a member with no role reads patient and report metadata (I04, decision DA-1).

## Decisions this plan rests on

These are the audit plan's DA-1 and DA-2, restated as what they mean for this slice. **Both need a yes or a change from the founder before any code starts.**

| # | Decision | Recommendation | If the founder says otherwise |
| --- | --- | --- | --- |
| DA-2 | Where does membership and role authority live? | PostgreSQL membership table checked on every protected request; Cognito stays the identity provider (proves who you are, enforces MFA) and keeps its tenant group as a second, agreeing signal | Keep tokens as authority and shorten lifetimes: closes nothing, and the audit's finding stays open |
| DA-1 | May a tenant member with no role read clinical metadata? | No. The nine read routes require `reader`, `clinician` or `admin` (`reviewer` is additive and never enough alone) | Keep today's behavior; then M1.5 covers I03 only and `auth.md` keeps the "no role may read" row |
| DM-1 | Who changes membership? | A command-line tool run as the migration task (like `provision-logins`), with **no API endpoint** that creates, removes or re-roles people. This keeps the existing rule that an API must not be able to mint accounts or grant itself roles. An admin screen is a later slice with its own plan | An admin API now: needs its own authorization model, the four-identity rule for grants, and the audit store (M1.6) first; recommend not bundling |
| DM-2 | Ship I04 (the `@Roles` change on nine reads) in this PR or as a second, tiny PR? | Second PR, **M1.5b**, right after: it is independent of the table and easy to review alone. M1.5 changes where authority comes from; M1.5b changes what the nine routes ask of it | Same PR: larger diff, one review |

## Design

### 1. Data (one new migration, `0017_membership.up.sql` and a `.down.sql`)

`tenant_memberships`, one row per person per tenant, **never deleted** (a removed person's row is the tombstone):

| Column | Meaning |
| --- | --- |
| `tenant_id`, `sub` | primary key; the same ids the token carries and every other table already uses |
| `status` | `active` or `removed` (a third value, `suspended`, only if the founder asks; removal is reversible by re-granting) |
| `roles` | `text[]`, each value one of `reader`, `clinician`, `admin`, `reviewer` (check constraint, same list as `roleSchema`); the effective roles |
| `tokens_valid_after` | timestamptz. A token whose `iat` is at or before this instant is refused. Set to `now()` on removal, role downgrade and reinstatement; this is the revocation record |
| `version` | bigint, incremented on every change; used by the write boundary below |
| `changed_at`, `changed_by`, `reason` | who the operator was and why (free text, length-limited, no patient data); the immutable event trail is M1.6 |

Constraints: at most one `active` row per `sub` across all tenants (partial unique index: a person belongs to exactly one tenant, as today); `tenant_id` and `sub` length checks like the other tables; a trigger refuses changing the key. Row-level security reads `app.current_tenant_id` like every other table, so the API role sees only its own tenant's rows. The API role gets **SELECT only**: it can never grant, remove or re-role anyone. Writes come from the migration login the command-line tool uses; the exact RLS arrangement for that owner is decided in the implementation and proved by a privilege test either way.

### 2. Resolving authority on every protected request

`AuthGuard` keeps verifying the token (signature, issuer, client, expiry, age), which still yields identity: `sub`, the token's tenant, `iat`. It then asks a new `MembershipService` for the current row **on every request, with no caching of allow decisions** (the research package says not to cache at first). The request is refused when:

| Condition | Answer |
| --- | --- |
| No row, or `status = removed` | 403 (known identity, not allowed in); same shape as today's "account not set up" |
| The row's tenant differs from the token's tenant group | 403 (the two signals must agree; Cognito can still veto) |
| `iat` <= `tokens_valid_after` | 401, so the client signs in again and gets a token newer than the revocation |
| The database cannot answer (down, timeout, pool exhausted, malformed row) | **503**, no protected work done. Not 401: a 401 makes the browser start a new sign-in, and an outage would then loop |

The `Principal.roles` the rest of the code sees now come from the row, not the token. Token roles are ignored once this lands, so adding someone to a Cognito group no longer grants anything by itself. `GET /me` answers from the row. Public routes and the health probes are untouched. The cost is one primary-key lookup per request (inside the existing 2 s connect and 5 s statement budgets); a measurement goes in the verification note.

### 3. The commit boundary for writes

A guard-time read alone leaves a gap: authority could be removed between the guard and the commit of a long write. The boundary this slice defines and tests:

- Every protected **write** re-checks the row **inside the same transaction** as the write, with `SELECT ... FOR SHARE` on the membership row, and refuses unless the row is still active and its `version` equals the one the guard read. A removal or role change is an `UPDATE` of that row, which waits for in-flight shared holders and blocks new ones until it commits.
- So a write either took its shared lock before the change committed (it was admitted under the old authority and may commit), or it sees the change and is refused. **Requests admitted after the change commits are denied; data already returned before it cannot be recalled.** That sentence goes into [auth.md](../../auth.md) as the documented boundary.
- Implementation point: `Database.withTenant` gains an optional `authority` (the principal's `sub` and expected `version`). Write paths in the four Postgres repositories pass it; there are 35 `withTenant` call sites across four repository files, so the change is mechanical but wide. Reads rely on the guard check.
- When the version moved but the person is still allowed, the request is refused with 403 and the client retries once; this is rare and the safe direction.

In-memory storage (tier 1) gets an equivalent store with the same rules so the three-tier test structure still holds. It cannot show a lock race; the race proof is a PostgreSQL-tier test.

### 4. What stays out

- **No application logout endpoint and no BFF session store.** T03 lists them; they belong to M5.1 (same-origin BFF sessions, DA-6), which depends on this slice. Revoking a *person* is done here; revoking a *browser session* is later. A revoked token cannot "bootstrap a replacement session" because no application session exists yet; the equivalent control here is `tokens_valid_after`.
- **No security-event audit store (M1.6).** Membership changes record `changed_at`, `changed_by` and `reason` on the row, which is overwritten by the next change. The append-only trail of invites, grants and removals is M1.6 and will hook into the same command-line tool.
- No Terraform, Cognito or AWS change; nothing applied. No change to ledger, tenancy or patient-data code beyond passing `authority` into `withTenant`.
- Organization-owned background processing after a person is removed: there are no jobs yet (T08), so there is nothing to reconcile; the rule gets written when that slice does.

### 5. The command-line tool and runbook

`db membership grant|set-roles|remove|show` (names settled in the implementation), run as a one-off task with the migration login exactly like `provision-logins`, writing the row and `tokens_valid_after` in one statement. `docs/ops/membership.md` (new) replaces the Cognito-only invite and offboard steps in [auth.md](../../auth.md): Cognito still creates the account and MFA; the tool grants membership. Offboarding becomes: `membership remove` (effective on the next request, on every replica), then disable the Cognito user. A one-time import of existing Cognito users is not built: nothing is applied and there are no real users; a note says that the first deployment starts with an empty table and the first administrator is granted by the tool.

## Tests and verification plan

| Check | Proves |
| --- | --- |
| Two API instances sharing one PostgreSQL: remove a member; the same old token is refused (401 or 403) on **both** | T03 criterion 1 |
| Downgrade `clinician` to `reader`; the next request with the *same* token is refused on a write route and allowed on a read route | criterion 2 |
| Token issued before `tokens_valid_after` is refused; a token issued after reinstatement works | revocation record |
| Membership lookup that throws or times out: 503 on a protected route, nothing written; health probes still answer | criterion 4 |
| Race (PostgreSQL tier): hold a write transaction open after its shared lock, start a removal, release; assert the write committed before the removal's commit **or** was refused, never committed after, over many iterations with both orderings forced | criterion 5 |
| Token groups no longer grant: a token that claims `admin` for a person whose row says `reader` is a reader | authority moved |
| Token tenant group disagreeing with the row: 403 | the two signals agree |
| Privilege test: the API login cannot INSERT, UPDATE or DELETE `tenant_memberships`; a person cannot read another tenant's membership row | no self-grant, tenant isolation |
| Migration up and down, privilege facts and the restore manifest include the new table and rule | schema drift checks |
| Defect injection, per working agreement 6: skip the in-transaction check; ignore `tokens_valid_after`; trust token roles; fail open on a lookup error. Each must turn a named test red | each rule is real |
| The existing suites that mint test tokens (20 files) keep passing through a test-only wrapper that writes each test token's roles into the membership table (so they keep proving routes work); the new suites turn the wrapper off and prove authority | no loss of coverage, no false confidence: the wrapper is test-only and a test asserts production wiring never contains it |
| Full local regression: typecheck, lint, build, `test:infra`, `test:ci-config`, the three backend tiers (recovery tests as an unprivileged user), frontend; required CI checks on the PR head | nothing else moved |

## Files expected to change

New: `apps/backend/migrations/0017_membership.{up,down}.sql`; a membership module (repository abstract class, in-memory and PostgreSQL implementations, service); the command-line tool; `docs/ops/membership.md`; new specs and a verification note.
Changed: `auth.guard.ts`, `principal.ts`, `database.ts` and the four Postgres repositories (pass `authority`), `me.controller.ts`, `storage.module.ts` and `auth.module.ts` wiring, `privilege-facts.ts`, the restore manifest, `test/helpers`, `docs/auth.md`, `docs/database.md`, `docs/STATUS.md`, this plan.

## Risks to watch

- **Wide, mechanical write-path change** (35 call sites): kept reviewable by one helper and a test that fails if a write path omits `authority`.
- **First deployment locks everyone out until membership is granted.** Acceptable today (nothing applied, no real users) and written into the runbook so it is not a surprise later.
- **Extra query per request.** Measured, not assumed; caching is deliberately not added.
- **Concurrent tenant move.** Removing from A and granting to B are two commands; between them the person is refused, the same fail-closed behavior as today's Cognito move.

## Changes from this plan

Differences between what is written above and what was built, each in the direction of a stronger or simpler result:

1. **The commit-time check runs just before `COMMIT`, not at the start of the transaction.** A write that has done its work and then finds the person removed is rolled back whole. This is a stronger boundary than the "re-check at the start" described in section 3: nothing commits after the removal commits. The check is skipped for transactions that wrote nothing (detected with `txid_current_if_assigned()`), so reads take no lock.
2. **No signature changes across the 35 call sites.** The request's membership version travels in a per-request `AsyncLocalStorage` slot (`authority-context.ts`), opened by a middleware in `configureApp` and filled by `AuthGuard`; `Database.withTenant` reads it. Code with no request behind it (background work) is not tied to a person; `asOrganizationWork()` detaches work that is the organization's rather than the person's; it is used for closing out a failed upload transfer (recording that nothing was stored and releasing the quota reservation), so a person removed mid-upload leaves nothing stranded. If the slot is missing when the guard runs, the request fails rather than skipping the check.
3. **The check is a `SECURITY DEFINER` function, not a plain `SELECT ... FOR SHARE`.** PostgreSQL requires the UPDATE privilege to take a row lock, and the application role must stay read-only. The function reads only the organization the transaction is bound to.
4. **A role change does not move `tokens_valid_after`.** Roles are read live, so a downgrade already takes effect on the next request; forcing a fresh sign-in on every role change would only add friction. Removal, reinstatement and `revoke-sessions` move it. (`revoke-sessions` is a small addition: refuse every token issued so far without removing anyone.)
5. **A development mirror.** On the in-memory store (never production, never PostgreSQL) the membership mirrors the verified token so a local server and the default browser suite have people to check; the existing token-minting test suites use the same mirror over the real table, and the new suites run without it. A test asserts the production wiring never contains it.
6. **The verifier reports `issuedAt`** (the token's `iat`) alongside the identity.
7. **Browser suite on PostgreSQL** (`e2e:storage`, a manual local procedure) needs its personas granted once; the steps are in [local-storage-browser.md](../../ops/local-storage-browser.md#memberships).

## What I needed from the founder

DA-1, DA-2, DM-1 and DM-2: all four answered yes on 2026-10-13.
