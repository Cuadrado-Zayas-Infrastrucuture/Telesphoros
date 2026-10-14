# M2.1c-1 wrong-chart quarantine: verification

Implementation on local branch `claude/m2-1c-1-quarantine-v2`, **stacked on the M2.1b branch** (`claude/m2-1b-patient-identifiers-link-v2`, which carries M2.1a; neither is a pull request yet; M1.5, M1.5b and M1.6 are merged into `main`). It has no migration of its own, so nothing was renumbered when it was moved here by cherry-pick from the earlier local stack (`claude/m2-1c-1-quarantine`, kept as the old branch). Plan and decisions DQ-1 to DQ-8 (answered yes by the founder on 2026-10-14): [m2-1c-wrong-chart-and-duplicates.md](../design/plans/m2-1c-wrong-chart-and-duplicates.md). Results below were captured locally on 2026-10-14 on the moved branch. **Not pushed, no pull request yet (kept local at the founder's request), so no remote CI has run and none of the required checks is claimed.** Synthetic data only; nothing applied in AWS.

## What was implemented

No migration and no new table. Quarantine is derived from records that already exist.

| Change | Where |
| --- | --- |
| `advisory.patientLink` (`verified`, `unverified`, `rejected`) on every evaluation read; the quarantine entry contract | `packages/shared-types/src/lab-report.ts` |
| "Current" has one more way to be none: a report whose newest link decision, about the file and patient it holds now, is a rejection | `storage/postgres/ledger-records.repository.ts` (`CURRENT_EVALUATIONS_SQL`, one shared `LINK_APPLIES` condition) |
| Link state of many reports in one statement; the reviewer work list (one statement for count and page; active means no terminal correction) | the same file, `storage/ledger-records.repository.ts`, `storage/ledger-records.ts` |
| Evaluation reads carry the link state; `GET /patient-link/quarantine` (role `reviewer`, pipeline route, paged) | `lab-reports/evaluations.service.ts`, `lab-reports/lab-report.mapper.ts`, `patient-identity/*` |
| The SMART stored-PGx preview withholds a result unless the link is verified | `packages/smart-pilot/src/stored-pgx.ts` |
| Docs | `records-and-corrections.md` (4.5), `lab-report-reader.md`, STATUS, the plan |

## Tests added or changed

| Test | Proves |
| --- | --- |
| `test/patient-quarantine.e2e-spec.ts` (10; PostgreSQL, pipeline on) | A rejection changes how an evaluation reads (`patientLink: rejected`, not current, absent from `current=true`) and **nothing else about it** (the stored fields are equal before and after); a later verification of the same file restores it; a replaced file reads as unverified and current, not quarantined; another report of the same patient is unaffected; the work list shows exactly the quarantined reports with their active evaluation ids, coded reasons and oldest first, pages with exact totals and omits a verified report; rejecting writes no correction; retracting each evaluation (and only then) removes the report from the list; a reinstatement puts it back; the list is the reviewer's alone (clinician, reader, administrator alone and no role are 403; administration plus reviewer is 200), is empty for another organization, refuses bad paging and a missing token, is 503 with the pipeline off; a reviewer can still read the capture, the file link and the evaluation of a quarantined report, and a new evaluation is still refused |
| `test/db/quarantine.pg-spec.ts` (9) | The state follows the newest decision, including for an evaluation stored with no decision at all (`unverified`), and returns to unverified after a file replacement whatever the old decision said; an unknown or another organization's report reads `unverified` with no leak, also with row-level security out of the way; "current" is none while rejected and returns on verification or replacement; other reports and organizations are unchanged; the list counts an evaluation as active through retraction, reinstatement and supersession, leaves out a verified, replaced or evaluation-less report, is ordered by the rejection with exact totals across pages, is tenant-scoped even for a superuser connection, and is `{items: [], total: 0}` when empty |
| `src/common/input-boundary.interceptor.spec.ts`, `test/db/query-plans.pg-spec.ts` | The new controller is in the strict-input inventory (17); the query-plan sample now has a verified and a quarantined report, and measures the link states and the list |
| `packages/smart-pilot/test/stored-pgx.test.js` (+2) | A result whose link is unverified or rejected is withheld, with the usual successful control |
| Updated fixtures: `LocalOperationsPage.test.tsx`, `local-e2e/foundation.spec.ts` | The evaluation contract has the new field |

## Defect injection

Each rule was broken on purpose with a script that edits the source, runs the named tests and restores the file (no backup left).

| Injected defect | Result |
| --- | --- |
| A rejected report's evaluations stay current | 4 failed |
| A rejection about an earlier file still quarantines | 4 failed |
| The state reads a rejection as verified | 6 failed |
| The work list shows retracted evaluations | 2 failed |
| The work list is not limited to the organization | 1 failed |
| The work list lists a report that is verified again | 3 failed |
| The work list is newest first | 1 failed |
| A clinician may read the work list | 2 failed |
| Evaluations always read as verified (mapper) | 3 failed |
| The evaluation read ignores the link state | 3 failed |
| The SMART preview ignores the link state | 2 failed |

## Local results

| Check | Result |
| --- | --- |
| Typecheck, lint, build (whole workspace) | pass |
| `test:ci-config`, `test:infra` | 35 of 35, 31 of 31 |
| Backend, in memory | 92 suites passed, 11 skipped; 1,360 tests passed, 239 skipped |
| Backend, PostgreSQL 16 plus Moto S3 | 146 suites, 2,150 tests passed (the three recovery suites excluded) |
| Frontend unit | 22 files, 263 tests passed |
| Smart-pilot package | 9 files, 188 tests passed |
| Shared types | 25 tests passed |
| Recovery suites (application, independent, CLI) as an unprivileged user from a copy of the repository | 3 suites, 37 tests passed |
| Browser, in memory (desktop and mobile) | 58 and 26 passed |
| Browser, PostgreSQL storage mode (`e2e:storage`), on a database migrated to 0020 with the runbook's tenants and personas | 26 passed, 1 failed: `version-pin.spec.ts` (waits for the old report list's "Next reports" button; failing before this slice, recorded in the M2.1a note) |

The recovery suites and both browser tiers, which the earlier version of this note listed as not re-run, were run on the moved branch (rows above). The defect-injection runs above were done before the move and not repeated; their guarding tests ran in the full runs.

## What this does not show

- No remote CI has run. Nothing was pushed, and there is no pull request yet.
- The query-plan sample has a handful of rows per tenant, so it proves the statements run and are counted once, not their cost at scale; the decision lookup uses the existing `(tenant_id, report_id, seq)` index but at this size the planner does not choose it.
- No screen shows the link state or the work list. The DEV-only local review page is unchanged.
- A quarantined report is not blocked anywhere else: its file, capture and evaluations stay readable (reviewers must be able to look), and nothing yet prevents someone relying on an evaluation that a reviewer has not retracted except the derived labels and the removal from "current".
- Duplicate review and merge (M2.1c-2) is not started.
- `docs/STATUS.md` on `main` is stale in places beyond this slice.
