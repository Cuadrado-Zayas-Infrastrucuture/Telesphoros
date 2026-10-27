# Chore: one fixture source per spec (spec 004, slice 2, local)

Date: 2026-10-27

Slice 2 of [spec 004](../../specs/004-reader-stand-in-coverage/plan.md). `FIXTURES` in `apps/backend/test/helpers/lab-pipeline.ts` was the engine's captures when the engine was in the checkout and the public synthetic fixtures otherwise, and `createTestApp` chose the test stand-in reader the same way. A spec written against one set failed against the other, so a run with the engine was not a superset of a run without it: `test/evaluation-request-worker.e2e-spec.ts` passed 13 of 13 without the engine and failed 1 of 13 with it.

Changed: nothing chooses by whether the engine is present. `fixturePdf`, `fixtureText` and `fixtureManifest` always read the public fixtures (`PUBLIC_FIXTURES`); `engineFixtures` reads the engine's captures (`ENGINE_FIXTURES`). `createTestApp` gives the pipeline the stand-in reader and the public fixtures unless the spec passes `readerEngine: true`, which uses the engine and its captures (the app refuses to start without the engine, as before). The seven group B files, still on the skip list until slice 3 writes their public fixtures, now ask for the engine by name; nothing else changes in them. `reader-engine.spec.ts` gains two checks: a spec that asks for the engine or its captures must be on the list, and no test helper may check for the engine. Each was seen failing on a mutation (ledger-watch taken off the list; the old `existsSync(ENGINE_FIXTURES)` switch put back) and passing on the change. `docs/lab-report-reader.md` says how a spec asks for the engine.

Proved, on PostgreSQL 16 with Moto for S3:

| Run | Result |
| --- | --- |
| Engine present, before the change, `evaluation-request-worker.e2e-spec.ts` | 12 of 13 (the dispute-overlay test fails), as recorded |
| Engine present, after, the whole backend suite, PostgreSQL tier | the worker spec 13 of 13; all seven group B files pass (capture 35, evaluation 64, negative 16, corrections 29, intake organization 17, text runner 25); `ledger-watch.e2e-spec.ts` 6 of 8 |
| `ledger-watch.e2e-spec.ts` with the engine and the #91 change applied on top, before #91 merged | 8 of 8: its two failures were the boot-jitter timeouts #91 fixes |
| Engine present, rebased onto `main` `35b72dc` (with #91), the whole backend suite, PostgreSQL tier | 241 files, 3450 passed, 21 skipped, none failed |
| Engine absent, after: root typecheck, lint, `pnpm test`, `test:ci-config`, `check:workflows`, three backend tiers | all pass; `ENGINE ABSENT` names 12 specs; 3018 tests per tier, no failures |
| Engine absent, on the rebased tip: the same loop and three tiers | all pass, no failures |

The first whole-suite run with the engine also failed 75 tests in nine backup, restore and recovery specs, because the run's PATH lacked the PostgreSQL 16 client tools those specs call; with them on PATH the nine files passed 103 of 103. That was the measuring script, not this change.

Not changed: production code, the stand-in, the fixtures, the oracle, the CI workflow and the skip list (still 12 files). Specs that are not on the list read the same public fixtures and stand-in they already read without the engine; with the engine present they now do the same, which is the point.

Local only until the pull request is opened.
