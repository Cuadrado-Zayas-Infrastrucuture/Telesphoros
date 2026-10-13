# M1.5b members with no role cannot read clinical records: verification

Implementation on local branch `claude/m1-5b-no-role-reads`, based on main `0e7e8d8` (after #91). Plan and the one departure from the approved wording: [m1-5b-no-role-reads.md](../design/plans/m1-5b-no-role-reads.md). Results were captured locally on 2026-10-13. **Nothing was pushed, so no remote CI has run and none of the required checks is claimed.** Synthetic data only; nothing applied in AWS.

## What changed

`CLINICAL_READ_ROLES` (`auth/clinical-read.ts`) and `@Roles(...CLINICAL_READ_ROLES)` on eleven read routes (patients, reports and recommendations list and by id; `GET /captures/:id`; evaluations and cell disputes list and by id). The audit named nine; `GET /recommendations/:id` and `GET /cell-disputes/:id` were also open. `docs/auth.md`, STATUS and the audit plan note updated. No database, frontend or Terraform change.

## Tests

| Test | Proves |
| --- | --- |
| `test/no-role-reads.e2e-spec.ts` (new, 26) | Walks the real route table: every protected route except `GET /me` declares roles. Each of the eleven reads is 403 (code `FORBIDDEN`) for a member with no role or an empty role list, and not 403 for each of the four roles (200 or 404 on the plain routes). `/me` answers a no-role member with `{ roles: [] }` and the health probe answers |
| Updated on purpose: `patients`, `auth-cognito`, `lab-reports-gate` (hand-written open-route list is now empty; the pipeline-off check uses a no-role token where every role is allowed), `lab-reports-capture`, `lab-reports-evaluation`, `lab-reports-disputes` | The old expectations ("a role-less caller may read") now expect 403, with the role-bearing controls kept |

Defect injection: removing `@Roles` from `GET /recommendations/:id` failed the route-table test and the 403 test (2 failed); dropping `reviewer` from the constant failed 12 tests (the reviewer controls and the route-table control).

## Local results

| Check | Result |
| --- | --- |
| `pnpm typecheck`, `lint`, `build`, `test:ci-config`, `test:infra` | passed |
| Tier 1 backend | 1,262 passed, 201 announced skips, 0 failed (up 26 from 1,236, all new tests) |
| Tier 2 and tier 3, full runs | Each had 2 failures: PostgreSQL-only lab-report suites (`lab-reports-capture`, `lab-reports-evaluation`) that still expected a role-less caller to read. I updated them (and the dispute suite's equivalent) and re-ran the five affected suites on tier 2 and on tier 3: 178 passed, 0 failed. **I did not re-run the full tiers 2 and 3 after that edit**; the other suites passed in the full runs (tier 2: 1,908 passed; tier 3: 1,928 passed) |
| Recovery suites (37 tests) as an unprivileged OS user | 37 passed |
| Browser, in-memory API | 56 + 18 passed |

## Limits

- The frontend is unchanged. A member with no role who opens the reports page gets the page's generic error, not a dedicated message; reviewer-only access is kept (see the plan). Neither was tested in a real browser against a no-role persona on PostgreSQL.
- The route-table test checks that roles are declared, not what each route returns for each role beyond the eleven reads.
- No remote CI, real Cognito or hosted environment.
