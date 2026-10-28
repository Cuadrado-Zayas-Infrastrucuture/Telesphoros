# Verification: the result reference in an evaluation (spec 006, D01a)

Date: 2026-10-27. Branch `feat/evaluation-result-reference`, rebased onto `main` `4dc4e33` (built first on `8d519b1`, then rebased onto `2531daf` and `2e39c84`). Plan: spec 006 `plan.md` (renumbered from 005 because `main` now has `specs/005-progressive-blur-edge`), D1 to D5, D7 and D8 approved by the founder on 2026-10-27 (spec branch `docs/data-products-d00`, not yet merged).

**What was claimed:** each result in an evaluation's detail and create response carries its stored `evaluation_results.id` and `ordinal`. No migration, ledger projection, record hash or export changes.

**Environment:** macOS, Node 22.22.0, pnpm 10.28.0, PostgreSQL 16.15 (own cluster with password checking, locale en_US.UTF-8), Moto 5.2.4 (the CI pin) on its own port. The report-reader engine is absent, as in every public checkout.

## Bug first

`apps/backend/test/evaluation-result-reference.e2e-spec.ts` was written before the change and run on unchanged code (PostgreSQL tier): **4 failed, 1 passed**. The failures were the missing `id`/`ordinal` and the strict schema accepting a result without `id`. The one pass was the ledger-verify test. It is an invariant that must hold before and after, not proof of the change, and is titled as one. With the change: **5 passed**. The oracle is the stored row, read through the administrator connection.

## Mutation checks

| Mutation (scratch edit, then restored byte-identical with `cmp`) | Result |
| --- | --- |
| M1: the mapper drops `id` and `ordinal` | 5 of 5 tests fail |
| M2: the schema makes `id` optional | exactly 1 fails: the strict-refusal test |
| M3: the "outsider" is put in the same tenant (added after the founder's diff review, with a positive control: the outsider lists their own tenant's evaluations with 200 first) | exactly 1 fails: the cross-tenant test, so its 404 is the tenant boundary |
| The SMART pilot export guard (`stored-pgx.test.js`: the bundle does not contain the result id) | **Not mutation-tested**. It guards against a future export change; breaking it would mean editing the FHIR builder. |

## Runs on the final, rebased tree (`main` `4dc4e33` + this change, dependencies reinstalled with `--frozen-lockfile`)

| Check | Result |
| --- | --- |
| `pnpm typecheck`, `pnpm lint`, `pnpm build` | pass (`pnpm format` changed nothing) |
| `pnpm test:infra` | 148/148 |
| `pnpm test:ci-config` | 205/205 |
| `packages/smart-pilot` | 188/188 |
| `apps/frontend` unit tests | 432/432 |
| Backend tier 1 (default, with `TEST_DATABASE_URL` and `TEST_S3_ENDPOINT` set) | 230 suites passed, 14 skipped; 2,995 tests passed, 277 skipped |
| Backend tier 2 (`TEST_STORAGE=postgres`) | 242 suites passed, 2 skipped; 3,251 passed, 21 skipped |
| Backend tier 3 (`TEST_STORAGE=postgres TEST_OBJECT_STORAGE=s3`) | 244/244 suites; 3,271 passed, 1 skipped |
| `TEST_STORAGE=postgres scripts/check-without-reader.sh --measure --listed` (the CI step from #101) | all 5 listed specs still fail without the engine; partialSkip counts match |
| Frontend Playwright (`pnpm e2e`: default, local and owned-local configs) | 112, 30 and 2 passed |
| gitleaks 8.30.1 over the branch commit | no leaks (after rewording a false positive, below) |

**Formerly engine-gated specs now run.** `main` `2531daf` includes spec 004's public fixtures, so `lab-reports-evaluation`, `lab-reports-corrections`, `lab-reports-evaluation-negative` and `lab-reports-capture` run without the engine: **144/144 passed with this change** (PostgreSQL tier, run separately as well as in the tiers).

**Still skipped:** the 5 specs in `apps/backend/test/helpers/reader-engine-specs.json` (`ENGINE ABSENT`). They test the engine itself and do not read evaluation DTOs.

## What the first full run found, and the fixes

1. `reader-engine.spec.ts` (tier 1, before the rebase): the guard required every spec naming the lab-pipeline helper to be declared engine-free. After rebasing onto `main` `2531daf` (spec 004's later slices), the guard no longer names that helper, so this branch keeps `main`'s file unchanged.
2. `lab-reports-disputes.e2e-spec.ts` (tiers 2 and 3, 2 tests): a new evaluation's untouched result was compared to the earlier one as a whole object. It now differs only in `id`, by design, because each evaluation stores its own rows. The comparison now excludes `id`, and a new assertion checks that the ids differ; nothing was removed.
3. `stored-pgx.test.js` (SMART pilot): its fixture built a result without `id`/`ordinal`, which the strict schema refused (the consumer break the plan predicted). The fields were added, plus the export guard above.

## Tier 2 timeouts before the rebase

The clean rerun had 2 failures in `test/db/report-registration.pg-spec.ts`. Both were 5-second Jest timeouts while creating and migrating a throwaway database; no assertion failed. The spec touches no code this change affects. Run alone twice it passed 7/7, at 6.0 s and 5.5 s. Two other sessions' Jest suites were running on the machine (load average about 7 to 8). **Cause unproven (likely load).** A second full tier-2 run passed with no failures (counts above).

## Not verified

- Hosted CI.
- The engine-present run of the 5 specs still on the engine list.
- Any deployed environment.
- The `e2e:storage` Playwright configuration (not run). The first `pnpm e2e` attempt did not start: the Python on `PATH` had no Moto. It passed once Moto 5.2.4 was put first on `PATH`.
- Each Playwright run regenerates `docs/design/previews/*.png`; those were restored, not committed.
- A gitleaks `generic-api-key` false positive on this record's environment line (the word "authentication" next to a locale assignment) was reworded; no secret was involved.

There is no clinical content in this change.
