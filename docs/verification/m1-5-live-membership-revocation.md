# M1.5 live membership and revocation: verification

Implementation on branch `claude/m1-5-live-membership`, based on main `eb6d31f`. Scope and decisions: [slice plan](../design/plans/m1-5-live-membership-revocation.md). All results below were captured locally on 2026-10-13; **no remote CI has run on this branch** (it is kept local at the founder's request), so none of the required checks (`verify`, `database-and-storage`, `browser`, `terraform`, `secret-scan`, `image`) is claimed. Synthetic data only; nothing was applied in AWS; nothing was tested against real Cognito or RDS.

## What was implemented

| Change | Where |
| --- | --- |
| Migration 0017: `tenant_memberships` (never deleted, one active row per person, version bumped by trigger, revocation instant never moves back), read-only RLS for the API login, `membership_assert_current()` (`SECURITY DEFINER`, execute for the API role only) | `apps/backend/migrations/0017_membership.{up,down}.sql` |
| Authority from the row on every protected request: 403 no active membership, 401 token older than the revocation instant, 503 when the lookup fails; roles come from the row | `auth/auth.guard.ts`, `auth/membership.service.ts`, `storage/membership.repository.ts`, `storage/postgres/membership.repository.ts` |
| Commit boundary: a request's write transaction locks the caller's membership row shared and compares the version just before `COMMIT` (read-only transactions skip it) | `db/database.ts`, `auth/authority-context.ts`, `app.factory.ts` |
| Organization-owned close-out of a failed upload transfer is not tied to the person | `reports/intake/intake.service.ts` |
| Operator command `membership grant | set-roles | remove | revoke-sessions | show` (no API route) | `membership/*`, `db/cli.ts` |
| Verifier reports `iat`; dev-only mirror of token claims on the in-memory store | `auth/token-verifier.ts`, `auth/cognito-token-verifier.ts`, `auth/mirror-token-verifier.ts`, `auth/auth.module.ts` |
| Docs | `docs/auth.md`, `docs/ops/membership.md`, `docs/database.md`, `docs/architecture.md`, `docs/ops/local-storage-browser.md`, STATUS, plan, Terraform comment (no resource changed) |

No Terraform resource, dependency or frontend source changed.

## Tests added or changed

| Test | What it proves |
| --- | --- |
| `test/membership.e2e-spec.ts` (16, runs in all three tiers, without the token mirror) | No membership: 403, then granted: 200. Roles come from the row (a token claiming admin for a reader is a reader). Removal and role downgrade apply to the next request with the same token. Old token 401 after removal-then-reinstatement, a new one works; revoke-sessions; revocation instant never moves back. One active organization per person; refusals for unknown roles. A failing lookup is 503 with nothing leaked and nothing written, and recovers. Two API instances on one store both refuse after a removal, a downgrade and a revocation |
| `test/db/membership.pg-spec.ts` (17) | The API login can read only its own organization and cannot insert, update, delete or truncate; the owner cannot delete or move keys or move the revocation instant back; one-active-per-person, role and length checks; the commit check is callable by the API role only and sees only its own organization. **Commit boundary:** a write admitted before a removal is rolled back whole (403); a removal waits while a write holds the check and nothing commits after it; 24 randomized interleavings leave every write committed whole or absent, with both outcomes occurring; read-only transactions take no lock; every write kind (patient, report, upload declaration, raw-stream upload bytes, deletes) calls the check and reads never do; a removed person's failed transfer is closed out and its reservation released; the operator command's behavior and output; an unreachable database gives 503 without leaking |
| `test/db/ledger-catalog.pg-spec.ts` (+1), `test/db/query-plans.pg-spec.ts` (+1) | New table is classified and has the right privileges, policy and triggers; the per-request lookup uses the primary key in a table of 4,500 members |
| `src/auth/auth.module.spec.ts` (+2), `src/auth/token-verifier.spec.ts` (+1) | PostgreSQL wiring never mirrors tokens, the factory refuses to mirror anywhere but the in-memory store, `iat` is reported |
| Updated: five migration-list specs, schema acceptance, readiness outage test (now 503, before any work), recovery CLI migration count | Mechanical updates for 0016 and the new fail-closed answer |

## Failure before, success after: defect injection

Each rule was broken on purpose, the named tests failed, and the file was restored (checked by grep). Nothing here was run against unchanged code first because the feature did not exist; the injections are the proof that each test can fail.

| Injected defect | Result |
| --- | --- |
| Skip the commit-time check in `Database.withTenant` | 5 failed (boundary, role-change, rollback, interleavings, every-write-kind) |
| Ignore `tokens_valid_after` | 3 failed |
| Use the token's roles instead of the row's | 8 failed |
| Fail open when the lookup throws | 1 failed (the 503 test) |
| Remove `FOR SHARE` from the check function | 1 failed (removal no longer waits for the writer) |
| Remove the version comparison from the check function | 2 failed |
| Check read-only transactions too | 2 failed |
| Grant the API role INSERT and UPDATE on the table | 2 failed |
| Guard never binds the request's authority | 1 failed (no write kind reaches the check) |
| Run organization-owned close-out as the person | 2 failed (the transfer and the helper) |

The first full tier-3 run also exposed a **race in my own test mirror** (two simultaneous first requests for one person raced the mirror's insert, giving a 401 in `local-storage-bounds`): without the advisory lock in the mirror that spec failed 1 of 3 runs, with it 3 of 3 passed (and the final full runs passed). That is a test-helper fix, not product code.

## Full local regression

Node 22.22.0, pnpm 10.28.0, frozen lockfile. PostgreSQL 16 on a loopback trust-authentication dev cluster, Moto 5.2.3 in an isolated virtual environment.

| Check | Result |
| --- | --- |
| `pnpm typecheck`, `pnpm lint`, `pnpm build` | passed |
| `pnpm test:ci-config`, `pnpm test:infra` | 35 and 31 passed, 0 failed |
| Tier 1 (backend, no database or S3 variables) | 1,247 passed, 201 announced service-dependent skips, 0 failed (up 22 from 1,225). Frontend 222, SMART pilot 186, CPIC schema 36, shared types 22, fake IDP 7, Lambda notifier 9, orchestration and storage-ops 22: all passed |
| Tier 2 (PostgreSQL) | 1,914 passed, 20 skips (password-check suites on a trust cluster), 0 failed |
| Tier 3 (PostgreSQL + Moto) | 1,934 passed, 0 skipped, 0 failed |
| Recovery rehearsal suites (3 files, 37 tests) | They refuse to run as root, as in the sandbox. Run as an unprivileged OS user from a copy of the repository: **37 passed**. (Two defects in my test helpers were found and fixed on the way: the recovery rig restores into its own server, so the test mirror needed that server's owner URL, and one hard-coded migration count.) |
| Browser, in-memory API (`pnpm e2e`) | 56 + 18 passed, 0 failed (the development mirror lets the fake personas in) |
| Browser on PostgreSQL (`e2e:storage`, manual local suite) with personas granted using the documented commands | 24 of 25 passed. The one failure, `version-pin.spec.ts`, timed out on stale selectors for the old reports list markup (the page is now a table); it does not touch authentication. Fixed in [#115](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/pull/115), which confirmed that cause |
| Built operator command run end to end | grant, refusal of a duplicate and of an unknown role, set-roles, remove, show, an unknown command and the usage text all behaved as documented; a person with no roles can be granted with `--roles ""` |

Measured cost of the per-request lookup on this machine: 0.68 ms sequential, 0.42 ms with 10 concurrent connections (loopback; one transaction of four statements). Over a network to RDS add round trips; **not measured against RDS or under load.**

## Limits

- Nothing was run against real Cognito, real RDS, or any hosted environment. The membership behavior is proved against a fake identity provider and a local PostgreSQL.
- The in-memory tier cannot show the commit-time lock (a PostgreSQL guarantee); that is proved in the PostgreSQL tier only.
- The 401 on the revocation instant compares whole seconds of the token's `iat` with the database clock; a token issued in the same second as a revocation is treated as revoked, and clock differences between Cognito and the database shift that window by their size.
- A valid-token flood still costs one lookup per request before the per-person limit applies (the per-address limit runs first).
- Membership changes keep only the latest author and reason on the row; the append-only trail is M1.6. Browser sessions and a logout endpoint are M5.1. The no-role read change (finding I04, DA-1) is the separate M1.5b and is **not** in this change.
- The first deployment starts with nobody granted; there is no import of existing Cognito users.
- Because no push was made, the required CI checks have not run for this branch.

## Integration with main after #94 (2026-10-14)

While this branch waited, `main` gained the local application access audit (PR #94, migration `0016_security_access_audit`, `SecurityAuditStore`), which had also taken migration number 0016 and which its own note said could not be integrated unchanged with this branch. Merged `main` into this branch: the membership migration is now **0017** (files, lists in six migration specs, the recovery manifest count, docs), `AuthGuard` takes both `MembershipService` and `SecurityAuditStore` (it records `api-auth accepted` right after the token verifies, before the membership is read, and `refused` as before), `app.factory` keeps both middlewares, and the readiness outage test keeps the membership version of its assertion. `security-audit.pg-spec` now allows the membership drop on purpose to reach the audit migration's own guard, then re-applies 0017. Re-run after the merge: typecheck, lint, build, `test:ci-config` and `test:infra`; backend in memory (85 suites, 1255 tests) and on PostgreSQL plus S3 (134 suites, 1946 tests, after the two fixes above); the three recovery suites as an unprivileged user (37); frontend unit (22 files, 258 tests); browser tier in memory (58 and 26). Not run against anything real: still no Cognito, RDS or CI.
