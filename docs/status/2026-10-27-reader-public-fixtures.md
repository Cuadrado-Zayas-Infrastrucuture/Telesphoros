# Feature: nine public fixtures, and the fixture-gated specs in CI (spec 004, slice 3, local)

Date: 2026-10-27

Slice 3 of [spec 004](../../specs/004-reader-stand-in-coverage/plan.md). After slice 2, seven listed spec files still ran the engine only because public fixtures existed for D01, D02 and D08 alone, so every hosted run skipped them.

Changed:

- **Fixtures.** `scripts/test-fixtures/lab-report-fixtures.cjs` writes nine more synthetic fixtures, D03 to D07 and D09 to D12, one per remaining case of the hand-written oracle (`tests/report_adapter/golden.json`, unchanged). Seven of them use the stand-in's existing line format; `data/fixtures/lab-reports/README.md` says what each one is and what the fixtures do not prove.
- **One new stand-in layout.** D10 and D11 need a report whose values nothing ties to a gene, so the reader abstains. `stand-in-reader.ts` gains `Layout: unassociated-values`: listed genes and values become candidates with no frame, and the projection abstains (`registered-source-ambiguity`) with every candidate as unassociated evidence, which is what `packet-checks.ts` verifies. FR-006 controls in `test/stand-in-reader.spec.ts`: the unmodified packet is accepted; resealed packets that drop an evidence entry, claim the set is resolved, or give up their ambiguity evidence are each refused as `packet-invalid`; a gene line or an empty value in the list layout is held.
- **Seven files into CI.** `lab-reports-capture`, `lab-reports-evaluation`, `lab-reports-evaluation-negative`, `lab-reports-corrections`, `ledger-watch`, `reports-intake-organization` and `fake-text-capture-runner` now use the public fixtures and the stand-in, and leave the skip list, which names only the 5 files that test the engine itself. Two limiter tests in `lab-reports-evaluation-negative` wrapped the engine's reader only as a delegate; they now wrap the stand-in, as the worker and cancel specs already do. No assertion was changed or removed.
- **Guard.** `reader-engine.spec.ts` no longer treats importing `test/helpers/lab-pipeline` as needing the engine (since slice 2 a spec asks for it by name, which its next test checks), so ten measured exceptions are gone. The "asks for the engine" check was seen failing again on a mutation (`readerEngine: true` put back into `ledger-watch`).
- **Docs.** `docs/lab-report-reader.md` ("Where the 5 run") and `docs/ops/ci-cd.md` give the new counts.

Proved, on PostgreSQL 16 with Moto for S3:

| Run | Result |
| --- | --- |
| Oracle spec with all twelve ids, before the fixtures | 20 failed |
| After the nine fixtures, before the new layout | D10 and D11 failed (4 tests), the other seven new ids matched the oracle |
| After the layout | `test/stand-in-reader.spec.ts` 38 of 38 |
| The seven files, engine absent, PostgreSQL tier | all pass after the limiter delegate change (14 of 16 before it in `lab-reports-evaluation-negative`) |
| Engine present, the whole backend suite, PostgreSQL tier | 3472 passed, 21 skipped, none failed |
| Engine absent: root typecheck, lint, `pnpm test`, `test:ci-config`, `check:workflows`, three backend tiers | all pass; `ENGINE ABSENT` names 5 specs; 3234 tests per tier (3018 before) |
| Engine absent, rebased onto `main` `afde8ec` (with #94): the same loop and three tiers | all pass; 3235 tests per tier, none failed |
| Rebased again onto `main` `8d519b1` (#95, worker only; no backend file changed): typecheck, lint, `pnpm test` | all pass |

Time: local tiers took 335, 373 and 613 s. Tier 3 ran while another session ran its own suites on the same machine, so that figure is contended; the hosted time will show on the pull request.

Not changed: production code, the adapter, the rules engine, the oracle, the CI workflow. The 5 engine-only files keep the manual run recorded in `docs/lab-report-reader.md`; slice 4 splits the engine-free tests out of `subprocess-report-reader.spec.ts` and adds the CI step that re-measures the list.

Local only until the pull request is opened.
