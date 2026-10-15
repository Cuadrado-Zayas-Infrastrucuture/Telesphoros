# M2.1c-2 duplicate review and merge: verification

Implementation on local branch `claude/m2-1c-2-duplicates-merge`, **stacked on M2.1c-1** (`claude/m2-1c-1-quarantine-v2`, which carries M2.1b and M2.1a; none of the three is a pull request yet; M1.5, M1.5b and M1.6 are merged into `main`). Plan and decisions DQ-1 to DQ-8 (answered yes by the founder on 2026-10-14): [m2-1c-wrong-chart-and-duplicates.md](../design/plans/m2-1c-wrong-chart-and-duplicates.md); how it was made concrete and where it differs: [m2-1c-2-duplicates-and-merge.md](../design/plans/m2-1c-2-duplicates-and-merge.md). Results below were captured locally on 2026-10-14. **Not pushed, no pull request (kept local at the founder's request), so no remote CI has run and none of the required checks is claimed.** Synthetic data only; nothing applied in AWS.

## What was implemented

| Change | Where |
| --- | --- |
| Migration 0021: `patient_duplicate_flags`, `patient_merge_proposals`, `patient_merge_decisions`; forced row-level security; alias functions `patient_alias_edges`, `patient_merged_into`, `patient_group_ids`, `patient_merge_refusal`; decider-is-not-proposer trigger; deferred graph trigger (SQLSTATE `PM001`); ledger event types, subject check and `ledger_event_row_exists` extended | `apps/backend/migrations/0021_*` |
| Widens M2.1b: an identifier match may name an identifier of any patient in the report patient's group (new unique key `patient_identifiers_id_tenant_uq`, new foreign key, replaced `report_patient_decisions_check()`) | same migration |
| Contracts: merge create/decision/dto/list query, duplicate candidate, `includeMerged`, `mergedInto` | `packages/shared-types/src/patient-merge.ts`, `patient.ts` |
| Ledger plumbing: event types, projections, `MergeRefusedError` (PM001), append-only classification | `src/ledger/*`, `src/db/append-only-tables.ts` |
| Repositories: proposal, decision, find, page (batched); duplicate flags recorded on a collision inside a savepoint; group-aware patient filters on reports, evaluations, recommendations; `mergedInto` on patients | `src/storage/**` |
| Routes `GET /patient-duplicates`, `POST|GET /patient-merges`, `GET /patient-merges/:id`, `POST /patient-merges/:id/decision`; `409 patient-merged` on reports and identifiers | `src/patient-merge/*`, `reports.service.ts`, `patient-identity.service.ts` |
| Docs | `records-and-corrections.md` (3.6b), `database.md`, `lab-report-reader.md`, STATUS, the plan note |

## Tests added or changed

| Test | Proves |
| --- | --- |
| `test/db/patient-merge.pg-spec.ts` (21; PostgreSQL) | The tables are append-only and tenant-isolated, also for a superuser connection; a decider who proposed is refused by the database; one decision per proposal; a merge makes the source an alias, rewrites no patient row (row fingerprint equal before, after and after the unmerge) and the groups resolve from either end; a declined proposal changes nothing; every graph refusal (`same-patient`, `source-merged`, `target-merged`, `source-has-aliases`, `not-merged`, `patient-gone`) fires at commit with `PM001` even when the owner defers the trigger to immediate; two proposals that were each possible cannot both be approved (race under the ledger lock); a group identifier match is accepted and an outside one is not; the verifier accepts the chain |
| `test/patient-merge.e2e-spec.ts` (17; 16 on PostgreSQL, 7 in memory) | Collision leaves exactly one flag per pair whichever way round and however often, and no number or digest is in any other table (a control digest is searched for and found only where it belongs); who may propose and decide (an administrator alone, a reader, no role and no token are refused on every route); strict input validation; propose, different decider, groups read as one on reports and evaluations, and **an evaluation and its report read byte for byte the same before a merge, during it and after the unmerge**; merged-away patient takes no new report or identifier (409 `patient-merged`); identifier on one patient verifies a report of the other only once they are one; declined proposals dismiss the pair; refusal reasons are actionable; history paging and tenant separation; merges are 503 without the ledger while the duplicate list still works |
| `test/db/ledger-catalog.pg-spec.ts`, `test/db/query-plans.pg-spec.ts` | The flag table is classified; group resolution and the merges page run in a bounded number of statements (the planner-dependent index assertion was left out on purpose) |
| `src/common/input-boundary.interceptor.spec.ts` (19 controllers), `test/patients.e2e-spec.ts` (`mergedInto`), migration-list specs, `test/helpers/schema-acceptance.ts` | Strict-input inventory, patient contract, and the schema acceptance list know about 0021 |

## Defect injection

Each rule was broken on purpose with a script that edits the source or the migration, runs the named tests on PostgreSQL plus S3 and restores the file (verified afterwards: `git diff` shows only the slice).

| Injected defect | Result |
| --- | --- |
| Trigger lets the proposer decide | 1 failed |
| Graph rule not enforced at decision time | 5 failed |
| An unmerge does not end the alias | 2 failed |
| A group is only the patient itself | 7 failed |
| A merge into an alias is allowed | 4 failed |
| A patient with aliases may be merged away | 3 failed |
| An unmerge need not name a merge in force | 2 failed |
| An identifier of any patient verifies a link (group check dropped) | 1 failed |
| Reasons are not tied to the kind | 1 failed |
| The flag table can be edited by the application | 2 failed |
| Reports filter by patient ignores the group | 1 failed |
| Evaluations filter by patient ignores the group | 1 failed |
| Identifier match ignores the group (service) | 1 failed |
| A collision on the same patient leaves no flag | 1 failed |
| A declined pair is not dismissed | 1 failed |
| A merged-away patient takes new reports | 1 failed |
| A merged-away patient takes new identifiers | 1 failed |
| Merged-away patients are listed by default | 2 failed |
| An administrator alone may propose | 1 failed |
| The service no longer refuses the proposer deciding | 1 failed |

## Local results

| Check | Result |
| --- | --- |
| Typecheck, lint, build (whole workspace) | pass |
| `test:ci-config`, `test:infra` | 35 of 35, 31 of 31 |
| Backend, in memory | 93 suites passed, 11 skipped; 1,372 tests passed, 249 skipped |
| Backend, PostgreSQL 16 plus Moto S3 | 150 suites, 2,203 tests passed (1 skipped); the three recovery suites refuse to run as root and are the next row |
| Recovery suites (application, independent, CLI) as an unprivileged user from a copy of the repository | 3 suites, 37 tests passed |
| Frontend unit | 22 files, 263 tests passed |
| Smart-pilot package | 9 files, 188 tests passed |
| Shared types | 25 tests passed |
| Browser, in memory (desktop and mobile) | 58 and 26 passed |
| Browser, PostgreSQL storage mode (`e2e:storage`), on a database migrated to 0021 with the runbook's tenants and personas | 26 passed, 1 failed: `version-pin.spec.ts` (stale selectors in the spec itself; fixed in [#115](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/pull/115)) |

## What this does not show

- No remote CI has run. Nothing was pushed, and there is no pull request.
- No screen for duplicates or merges (M3.2). Nothing in the browser exercises the new routes.
- Merges are PostgreSQL-only, like every ledger record; the in-memory tier shows only the flags and the 503.
- Groups are one level deep by construction. A chain of aliases is refused, not resolved; wanting chains later is a new migration and a recursive query.
- The query-plan sample has a handful of rows per tenant, so it proves statements are bounded and counted, not their cost at scale.
- Retention (M0/T01): whether a merged patient's records must stay individually retrievable is undecided. Every row is kept and `includeMerged=true` shows merged patients, but there is no "pre-merge view".
- A merge decision authorizes nothing clinical: an evaluation stays pinned to the patient its report names. The 0021 widening means a report can be verified by an identifier of a merged-in patient; an unmerge does not retract a link decision made that way.
- The down migration of 0021 deletes merge records and fails on a database holding a group-identifier decision; it is for disposable databases and is guarded by `telesphoros.allow_audit_drop`.
- `docs/STATUS.md` on `main` is stale in places beyond this slice.
