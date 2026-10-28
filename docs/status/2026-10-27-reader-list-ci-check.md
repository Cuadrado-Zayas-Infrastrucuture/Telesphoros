# Chore: CI keeps the reader-engine list honest (spec 004, slice 4, local)

Date: 2026-10-27

Slice 4 of [spec 004](../../specs/004-reader-stand-in-coverage/plan.md). After slice 3 the list of specs skipped without the private report-reader engine (`apps/backend/test/helpers/reader-engine-specs.json`) names the 5 files that test the engine itself. It was measured by hand twice in one day and was stale both times before that; nothing checked it.

Changed:

- **A CI step** in `service-postgres`, after Tier 2 and inside the shared budget: `scripts/check-without-reader.sh --measure --listed`. It runs the listed files without skipping them and fails the job if one of them passes (it should leave the list) or a `partialSkip` count no longer matches. The other half of FR-004 needs no new step: a spec that needs the engine but is not listed is not skipped, so it fails the tier itself. `.github/ci/reader-list.test.mjs` pins the step (after the tier, inside the budget, once) and the script's usage refusals.
- **The script** works in a checkout that never had the engine (the public repository, CI): it renames nothing there, and refuses a checkout with only part of the engine. `--listed` (with `--measure`) runs only the listed files. A run in which Jest produced no results fails with the end of Jest's output, never passes.
- **The split (FR-005).** The 11 tests of `subprocess-report-reader.spec.ts` that need no engine (deadlines, the process-group kill, the output cap, malformed output, refusals made before spawning, logging) move unchanged into `subprocess-report-reader.wrapper.spec.ts`, which runs in every tier. The 46 that run the engine stay. The list has no `partialSkip` left.
- **Docs.** `docs/lab-report-reader.md` describes the check and the split.

Proved, on PostgreSQL 16 with Moto for S3:

| Run | Result |
| --- | --- |
| The listed check, clean | passes: all 5 still fail without the engine; about 5 s |
| The same with `test/ledger-watch.e2e-spec.ts` added back to the list (SC-003, locally) | fails and names it: "passes without the engine, so it should leave the list" |
| The same with a `partialSkip` count changed | fails and names the file, the listed count and the measured one |
| The same before dependencies were installed | fails with Jest's own error, not a parse error |
| `reader-list.test.mjs` with the step's command removed from `ci.yml` | 1 of 2 fails; both pass once restored |
| The split, engine absent | wrapper file 11 of 11; engine file 0 of 46 (all need the engine), 57 tests before and after |
| The split, engine present | both files 57 of 57 |
| Engine absent: root typecheck, lint, `pnpm test`, `test:ci-config`, `check:workflows`, three backend tiers | all pass, 3246 tests per tier; `ENGINE ABSENT` names 5 specs. Tier 3's first run timed out two tests in files this change does not touch (`stored-pgx-preview`, `security-events`) at a load average near 13; both passed 3 of 3 alone, and a full tier 3 rerun passed 3245 of 3246 (1 skipped by design) at a load average near 20. Cause of those two timeouts unproven. |

Rebased onto `main` `2531daf` (#96, a read-only connection-limits command; no file in common): typecheck, lint, `pnpm test`, `test:ci-config`, `check:workflows`, the reader guard, the wrapper spec, #96's connection-limits specs on PostgreSQL and the listed check all pass. The three tiers were not re-run after this rebase.

Not proved here: SC-003 and SC-002 on hosted CI (a throwaway branch that adds a listed file back, and one that reverts the #91 jitter fix). Each costs a hosted run, so they wait for the founder.

Not changed: production code, the engine, the stand-in, the fixtures, the oracle, the required checks and the ruleset.

Local only until the pull request is opened.
