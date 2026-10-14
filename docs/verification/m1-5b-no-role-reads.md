# M1.5b members with no role cannot read clinical records: verification

Implementation on branch `claude/m1-5b-no-role-reads`. It was written on main `0e7e8d8` (after #91) and then merged with main `63822c2` (after #95, live membership); the only conflict was `docs/auth.md`, resolved by keeping main's membership wording and this change's no-role row. Plan and the one departure from the approved wording: [m1-5b-no-role-reads.md](../design/plans/m1-5b-no-role-reads.md). **No remote CI had run when this note was written; the pull request's own checks are the record.** Synthetic data only; nothing applied in AWS.

## What changed

`CLINICAL_READ_ROLES` (`auth/clinical-read.ts`) and `@Roles(...CLINICAL_READ_ROLES)` on eleven read routes (patients, reports and recommendations list and by id; `GET /captures/:id`; evaluations and cell disputes list and by id). The audit named nine; `GET /recommendations/:id` and `GET /cell-disputes/:id` were also open. `docs/auth.md`, STATUS and the audit plan note updated. No database, frontend or Terraform change.

## Tests

| Test | Proves |
| --- | --- |
| `test/no-role-reads.e2e-spec.ts` (new, 26) | Walks the real route table: every protected route except `GET /me` declares roles. Each of the eleven reads is 403 (code `FORBIDDEN`) for a member with no role or an empty role list, and not 403 for each of the four roles (200 or 404 on the plain routes). `/me` answers a no-role member with `{ roles: [] }` and the health probe answers |
| Updated on purpose: `patients`, `auth-cognito`, `lab-reports-gate` (hand-written open-route list is now empty; the pipeline-off check uses a no-role token where every role is allowed), `lab-reports-capture`, `lab-reports-evaluation`, `lab-reports-disputes` | The old expectations ("a role-less caller may read") now expect 403, with the role-bearing controls kept |

Defect injection: removing `@Roles` from `GET /recommendations/:id` failed the route-table test and the 403 test (2 failed); dropping `reviewer` from the constant failed 12 tests (the reviewer controls and the route-table control).

## Local results

Captured on 2026-10-14 on the merge with main `63822c2`.

| Check | Result |
| --- | --- |
| `pnpm typecheck`, `lint`, `test:ci-config`, `test:infra` | passed |
| Tier 1 backend (in memory) | 86 suites, 1,281 passed, 201 announced skips, 0 failed |
| Tiers 2 and 3 together (PostgreSQL 16 plus Moto S3), full run, recovery suites excluded | 134 suites, 1,966 passed, 0 failed |
| Before the merge (on `0e7e8d8`) | Recovery suites (37 tests) as an unprivileged OS user passed; browser tier with the in-memory API passed (56 + 18) |

**Not re-run after the merge:** the three recovery suites and the browser tier. This change has no database, frontend or Terraform edit, and the merge from main did not touch those paths in this change, but that is an argument, not a run.

## Limits

- The frontend is unchanged. A member with no role who opens the reports page gets the page's generic error, not a dedicated message; reviewer-only access is kept (see the plan). Neither was tested in a real browser against a no-role persona on PostgreSQL.
- The route-table test checks that roles are declared, not what each route returns for each role beyond the eleven reads.
- No remote CI, real Cognito or hosted environment.
