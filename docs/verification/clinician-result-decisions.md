# Verification: clinician result decisions (spec 006, D01b)

Date: 2026-10-28. Branch `feat/clinician-result-decisions`, built and verified on `main` `bb9f195`. Local only, not pushed. Plan: spec 006 `plan.md`, refreshed and approved by the founder on 2026-10-28. The deviations are in its "As built" note.

**Vocabulary:** the loops below ran on the 11-code proposal. On 2026-10-28 the founder decided D6: 13 codes (adding `drug-interaction` and `report-doubt`). The change touched the two lists and labels in `packages/shared-types/src/clinician-decisions.ts`, `clinician_decision_codes_valid()` in the migration, and the e2e rules. A test now compares the database's arrays with the shared lists exactly. See "After D6" at the end.

**What was claimed:**
- `POST` and `GET /api/v1/evaluation-results/:id/clinician-decisions`.
- A new append-only, ledgered record `clinician_result_decisions` (migration 0055, event type `clinician-result-decision`; built as 0054 and renumbered after #120 merged).
- Clinician-only by the live membership row.
- The basis rule `cdr-eligibility-v1` is checked after the ledger lock.
- Retries are idempotent through a required `requestId`.

**Environment:** macOS, Node 22.22.0, pnpm 10.28.0, PostgreSQL 16 (own cluster with password checking, locale en_US.UTF-8), Moto 5.2.4 (the CI pin) on its own port, the Playwright Chromium build. The report-reader engine is absent, as in every public checkout.

## Tests (expected values written by hand; the oracle is the database, read as the administrator, or the database's own refusal)

- `apps/backend/test/clinician-decisions.e2e-spec.ts`: **37**. Over HTTP:
  - T01, binding and tenancy;
  - T02, T03 and T09, retries and the request id;
  - T05a, T05c, T05d and T05e, the basis at commit, covering retraction, supersession, not current, patient-link rejection, and a dispute (dismissed again as the control);
  - T06;
  - the chain (`decision-stale`);
  - disagreement, plan change against correction, and author-only;
  - backdating and the time window;
  - each response's rules;
  - roles, including T04 in an app where the database alone holds memberships;
  - notes, T26 and T07/T08;
  - ledger verification.
- `apps/backend/test/db/clinician-decisions.pg-spec.ts`: **11**.
  - Direct SQL as the application role: the composite FK, the trigger's actor binding, the clinician role (`CD001`), author-only (`CD002`), the codes CHECK, the chain key, append-only, and a held result.
  - **T05b under real lock interleaving**: a decision holds the ledger lock, a dispute on the cited cell queues behind it (`untilBlocked`), and both commit. The decision stands and the history shows `disputed`.
  - T05a at the database.
- `down-guards-as-migrator.pg-spec.ts`: a populated table is refused **as the non-superuser migrator**, with and without the audit setting. The version stays applied and FORCE is restored. The existing "empty tables revert" test covers the empty case.

## Mutation checks (scratch edit, run, then restored byte-identical; the tree's status was compared before and after)

| Mutation | Result |
| --- | --- |
| M1 `@Roles` widened to reader and reviewer | caught (a reader on a missing result gets 404 instead of 403) |
| M2 the composite FK to the evaluation's patient removed | caught |
| M3 the post-lock basis re-check removed | caught (6 tests) |
| M4 the request-hash comparison removed | caught |
| M5 the first-entry chain index removed | caught |
| M6 the "not before the evaluation" bound removed | caught |
| M7 the trigger's actor binding removed | caught |
| M8 the trigger's clinician-role condition removed | caught |
| M9 the trigger's author-only rule removed | caught |

The first run had an API-side author check that duplicated M9. No test could tell it apart from the trigger, so it was removed rather than kept as an unprovable second copy. M1 was not caught at first, because the trigger gives the same 403. The 404-versus-403 test was added so that the decorator is proven on its own.

## The full local loop on `bb9f195`

| Step | Result |
| --- | --- |
| build, typecheck, lint (with prettier check) | pass |
| root tests; `test:infra` 148; `test:ci-config` 205 | pass |
| frontend 434; smart-pilot 188; worker 238 | pass |
| backend default tier | 3,017 passed, 326 skipped |
| backend `TEST_STORAGE=postgres` | 3,322 passed, 21 skipped |
| backend postgres + `TEST_OBJECT_STORAGE=s3` | 3,342 passed, 1 skipped |
| `check-without-reader.sh --measure --listed` | the 5 listed specs still fail without the engine; the partialSkip counts match |
| Playwright (default, local, owned-local) | 112, 30, 2 passed |
| gitleaks 8.30.1 (history at HEAD, and the changed directories) | no leaks |

The first Playwright run failed before any test ran. Its S3 fixture needs Moto on `PATH`, and the next attempt failed on the Chromium path. Both were environment problems, fixed by putting the pinned Moto venv on `PATH` and setting `CHROMIUM_PATH`. Nothing in the code changed between that attempt and the green run.

**Not run:**
- hosted CI;
- the 5 engine-only specs (no engine);
- `e2e:storage`;
- a rehearsal on staging (none exists).

## The full loop again, after the rebase onto `main` `bf99469` (commit `f6e84da`)

`main` gained #119 to #123 during the build. The rebase had one conflict, in the pipeline route list, where both routes are kept. It also had one **silent** merge error: #119 and this branch had each raised the controller count from 18 to 19, and git merged that as 19 when the true count is 20. That was fixed by hand. The dependencies were reinstalled from the lockfile before anything ran.

| Step | Result |
| --- | --- |
| build, typecheck, lint | pass |
| backend default / postgres / postgres + s3 | 3,036 / 3,353 / 3,373 passed (338 / 21 / 1 skipped) |
| frontend 449; smart-pilot 188; worker 241; `test:infra` 148 | pass |
| `check-without-reader.sh --measure --listed` | pass |
| Playwright (default, local, owned-local) | 118, 30, 2 passed |
| gitleaks | no leaks |
| root tests; `test:ci-config` | **failed in the loop, passed alone** (207 of 207). The root tests stopped before running any test: two vitest packages hit `ENOTEMPTY` on the shared `node_modules/.vitest-cache`. `ci-config` failed one timing test ("refuses timed-out producer exiting zero"). Both are recorded as **cause unproven**, not as fixed. |

## After D6 (2026-10-28): 13 codes

The founder accepted the recommendation:
- `drug-interaction` is split out of `clinical-context`;
- `report-doubt` is split out of `information-needed`;
- display labels move to one map, `CDR_CODE_LABELS`.

The vocabulary test used to look for code prefixes. It would have missed both new codes, so it now parses the database function's two arrays and compares them, in order, with the shared lists. It also checks the note-required array and that every code has a label.

| Check | Result |
| --- | --- |
| typecheck, lint, prettier; shared-types tests | pass (43) |
| backend `TEST_STORAGE=postgres` | 3,353 passed. The first run had 99 failures, all in 10 S3 and recovery suites, because the Moto emulator had been stopped. With Moto back, those 10 suites passed 106 of 106, and no other suite was affected. |
| M10: `report-doubt` removed from the database function | caught by the vocabulary test, then restored byte-identical |

Not rerun after this change: the default and S3 tiers, Playwright, the frontend and smart-pilot. The change touches only the vocabulary lists, the labels and the e2e rules. The full loop runs again before any push.

## Before the push: rebased onto `main` `f3070e9`, renumbered to 0055

H4 slice 2 (#120) merged with migration 0054, so D01b is now **0055**. The new 0054 does not touch the ledger's event types, so restating 0021's set is still right. The rebase had three conflicts: the policy count, the revert test's removed-object list and the route list. All three keep both sides. One count merged silently: #120 and this branch had each set the tenant-policy count to 53, and the true count is **55**. That was fixed by hand. The dependencies were reinstalled from the lockfile, and Moto was running for every backend tier.

| Step | Result |
| --- | --- |
| build, typecheck, lint, root tests | pass |
| `test:infra` 150; `test:ci-config` 207 | pass |
| frontend 468; smart-pilot 188; worker 241 | pass |
| backend default / postgres / postgres + s3 | 3,042 / 3,379 / 3,399 passed (358 / 21 / 1 skipped) |
| `check-without-reader.sh --measure --listed` | pass |
| Playwright (default, local, owned-local) | 130, 30, 2 passed |
| gitleaks | no leaks |

Every step passed in one run, including the two steps that were flaky before.

`main` moved again before the push, to `2de9610` (#132, #134). That rebase had one conflict, the shared-types index, where both exports stay. One count merged silently: #134 added a controller, and the inventory needs 21, not 20. That was fixed by hand. The full loop then ran once more on that exact tree, and every step passed:
- build, typecheck, lint, root tests;
- `test:infra` 150 and `test:ci-config` 207;
- frontend 468, smart-pilot 188, worker 241;
- the backend tiers, 3,053 / 3,390 / 3,410 passed;
- the reader-list check;
- Playwright 130 + 30 + 2;
- gitleaks.

**Last rebase before the push:** onto `c0de882` (#135 docs, #136 frontend usage page, #137 a recovery-storage fix). None of them touches a file this branch changes. On that exact tree: build, typecheck and lint pass; frontend 477; backend `TEST_STORAGE=postgres` 3,391 passed, 21 skipped. **Not rerun on this last base:** the default and S3 backend tiers, Playwright, smart-pilot and worker. They last passed one rebase earlier (`2de9610`). Hosted CI runs them all.
