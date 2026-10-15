# M2.1a tenant registry and member administration: verification

Implementation on local branch `claude/m2-1a-tenants-member-admin-v2`, **stacked on the M1.6 branch** (`claude/m1-6-security-events`, open as draft PR #97), because it extends the membership table and trigger and its migration follows M1.6's 0018: this slice is migration **0019**. M1.5 and M1.5b are merged into `main`. It was first written on a stack of local branches (as migration 0018) and moved here by cherry-pick; the earlier branch `claude/m2-1a-tenants-member-admin` is kept locally as the old stack. Plan, decisions DP-1 to DP-6 and what changed from it: [m2-1-onboarding-patient-identity.md](../design/plans/m2-1-onboarding-patient-identity.md#changes-from-this-plan-m21a). Results below were captured locally on 2026-10-14 on the moved branch. **Not pushed, no pull request yet (kept local at the founder's request), so no remote CI has run and none of the required checks is claimed.** Synthetic data only; nothing applied in AWS; nothing tested against real Cognito or RDS.

## What was implemented

| Change | Where |
| --- | --- |
| Migration 0019: `tenants` registry (immutable id and creation record, never deleted, row-level security), foreign key from `tenant_memberships`, `invitations` (keyed digest and masked hint, never the address; one pending per address; decided rows immutable), `member_admin_context()`, `member_change_roles()`, `member_remove()`, `invitation_create()`, `invitation_cancel()` (`SECURITY DEFINER`, organization and person from the transaction), membership audit trigger naming a person when an administrator acted | `apps/backend/migrations/0019_tenants_member_admin.{up,down}.sql` |
| `admin` is administration only: removed from every clinical read and write list, file links, intake; `GET /ledger/verify` stays `admin` | `auth/clinical-read.ts`, `auth/file-access.ts`, patients, reports, captures, evaluations, corrections, disputes controllers, `reports/intake` |
| Members module: six routes, rule errors mapped to stable answers | `members/*`, `storage/member-admin.repository.ts`, `storage/postgres/member-admin.repository.ts`, `storage/membership.repository.ts` (in-memory twin) |
| Suspended organization refused on every request, with a `tenant-suspended` refusal event | `auth/membership.service.ts`, `security-events/security-events.ts` |
| Operator commands `tenant create|list|suspend|activate`, `invite list|fulfil`; unknown organization refused on grant | `membership/tenant-cli.ts`, `pg-tenant-admin.ts`, `pg-invitation-admin.ts`, `pg-membership-admin.ts`, `db/cli.ts` |
| `INVITATION_DIGEST_KEY` required in production | `config/env.ts`, `members/invitation-digest.ts` |
| Terraform: secret container, execution-role read, task injection (nothing applied) | `infrastructure/terraform/api-compute.tf` and its two guards |
| Restore check keyed by `id` for the registry; classification lists | `db/restore.ts`, `db/append-only-tables.ts` |
| Shared types; frontend role lists and a clinical-read route guard; smart-pilot connector no longer accepts `admin` alone | `packages/shared-types/src/members.ts`, `apps/frontend/src/auth/roles.ts`, `app/routes.tsx`, `packages/smart-pilot/src/stored-pgx.ts` |
| Docs | `auth.md`, `database.md`, `ops/membership.md`, `ops/api-hosting.md`, `ops/local-storage-browser.md`, `ops/report-upload.md`, `ops/stored-pgx-preview.md`, STATUS, the plan |

No new dependency.

## Tests added

| Test | Proves |
| --- | --- |
| `test/members.e2e-spec.ts` (21; runs in memory and on PostgreSQL, without the token mirror) | An administrator lists only their own organization's people; a reader, clinician, reviewer or clinician-reviewer is refused every members route (403) and nothing changes; an administrator alone is refused patients, reports and recommendations while a person holding `admin` and `clinician` has both; a role change is felt on the person's next request; removal refuses them at once; no one changes or removes themselves (409 `member-self`); two administrators demoting each other at the same moment leave exactly one administrator; another organization's person gets the same 404 as nobody; unknown roles and malformed bodies are 400 and change nothing; an empty role set is allowed; a suspended organization is refused everywhere, administrators included, and works again when reactivated; invitations are created, listed and cancelled showing only a masked hint, never store or return the address, refuse a second pending one for the same address in any letter case (409 `invitation-pending`), are invisible to and uncancellable by another organization, stop at 100 pending (409 `invitation-limit`), and refuse bad input; a missing or already cancelled invitation is 404 |
| `test/db/member-admin.pg-spec.ts` (23) | The application login can insert, update, delete or truncate none of the three tables and reads only its own organization; `member_admin_context()` is not executable by it and the four functions are executable by it only; the functions refuse a transaction with no organization or no person, a person who is not an active administrator of the bound organization (including another organization's administrator), another organization's person (`member-not-found`), a suspended organization, self-change and self-removal even as the sole administrator; two administrators acting on each other at once leave exactly one; the membership's version bumps and `changed_by` names the administrator; the membership events say `person` for an administrator's act and `operator` for the operator's, also when nothing is bound; the foreign key refuses an unregistered organization; the registry's id and creation record cannot change and it cannot be deleted or truncated; the `tenant` commands register, list, suspend, activate and refuse duplicates and bad ids; invitations store a 32-byte digest and no part of the address, allow one pending per address and organization, cancel only their own organization's and only once, stop at 100 live pending (an expired one does not count), and are fulfilled by the operator only with the right address (any letter case), granting the invited roles once, with a wrong address, a cancelled invitation or an already-active person changing nothing |
| `src/config/env.spec.ts` (+2) | Production refuses a missing or malformed `INVITATION_DIGEST_KEY` |
| `infrastructure/terraform/api-compute.guard.test.mjs` (+controls) | The task injects the key from its secret (never plain environment), the service can read it, the secret is encrypted with the data key; each is proved by weakening the text |
| `src/common/input-boundary.interceptor.spec.ts` | The new controller is in the inventory of strict input pipes |
| Frontend `roles.test.ts`, `routes.test.tsx`, `ReportsPage.test.tsx` (+3); browser `e2e/auth.spec.ts`, `storage-e2e/dashboard.spec.ts` | Administrator alone is not a writer or a clinical reader; the upload page and report list tell them they lack access; administrator plus clinician is let in |

### Existing tests rewritten by hand (not loosened)

Where `admin` used to succeed on a clinical route the test now asserts 403 and adds a control that `admin` plus a clinical role succeeds: `no-role-reads`, `auth-cognito` (carol), `lab-pdf-reports`, `lab-reports-capture`, `lab-reports-evaluation`, `lab-reports-evaluation-negative`, `lab-reports-disputes`, `lab-reports-corrections`. Tests that make memberships now register the organization first (`membership.e2e`, `api-log-tenant`, `membership.pg-spec`, `security-events.pg-spec`, `query-plans.pg-spec`), and the migration lists in six specs moved to 0018.

## Defect injection

Each rule was broken on purpose with a script that edits the migration or source, runs the named tests, and restores the file (no `.inject-bak` file left; the unmutated suites were re-run green).

| Injected defect | Result |
| --- | --- |
| A person may change or remove themselves | 2 failed |
| The last administrator may be removed (rule deleted) | 1 failed (the concurrent test: the rule is reachable only through a race) |
| Another organization's people reachable (organization dropped from the lookup) | 2 failed |
| A suspended organization may still be administered | 1 failed |
| A non-administrator may administer | 1 failed |
| No per-organization lock | 2 failed (both race tests) |
| Membership events always say `operator` | 1 failed |
| `admin` added to the clinical read roles | 15 failed |
| `admin` added to who may create patients | 3 failed |
| A suspended organization is let in by the guard | 1 failed |

## Local results

| Check | Result |
| --- | --- |
| Typecheck (all packages), lint, build (whole workspace) | pass, no warnings |
| `test:ci-config` | 35 of 35 |
| `test:infra` | 31 of 31 |
| Backend, in memory | 88 suites passed, 9 skipped; 1,326 tests passed, 201 skipped |
| Backend, PostgreSQL 16 plus Moto S3 (the three recovery suites run separately) | 138 suites, 2,049 tests passed |
| Recovery suites (application, independent, CLI) as an unprivileged user from a copy of the repository | 3 suites, 37 tests passed |
| Frontend unit | 22 files, 261 tests passed |
| Smart-pilot package | 9 files, 186 tests passed |
| Browser, in memory (desktop and mobile) | 58 and 26 passed |
| Browser, PostgreSQL storage mode (`e2e:storage`), on a database migrated to 0019 with the runbook's tenants and personas | 26 passed, 1 failed: `version-pin.spec.ts`, whose selectors were stale (unrelated to this slice); fixed in [#115](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/pull/115) |

Moving onto `main` needed these changes beyond renumbering to 0019: the migration lists in six database specs and the recovery CLI's migration count; the security-event spec's membership helper; the schema-acceptance tables (`tenants`, `invitations` beside `security_events`); and one frontend test that `main` gained after this slice was written (`ReportsPage` empty-state upload offered to `admin` alone, now `admin` plus `clinician`, because `admin` no longer reads clinical records). The defect-injection runs recorded above were done before the move and not repeated; their guarding tests ran in the full runs.

## What this does not show

- No remote CI has run. Nothing was pushed, and there is no pull request yet.
- Nothing ran against real Cognito, RDS, Secrets Manager or ECS. The Terraform change is checked only by the repository's text guards, not by `terraform plan`.
- No screen exists for member administration; the routes are API-only.
- An organization's administrator cannot read its security events (planned, deferred); invitation creation, cancellation and fulfilment write no security event because the M1.6 catalogue is fixed (membership grants made by `invite fulfil` are recorded by the M1.6 trigger).
- `invite fulfil` grants a membership but does not create the Cognito account or its `tenant:` group; the operator does that first.
- The "last administrator" rule can only fire through a race; it was proved through that race, not by a sequential request.
- `docs/STATUS.md` on `main` is stale in places beyond this slice.
