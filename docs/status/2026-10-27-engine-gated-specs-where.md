# Docs: where the engine-gated specs run

Date: 2026-10-27

From the 2026-10-27 audit of public `main`. The 20 backend spec files that need the private report-reader engine are skipped in every hosted CI run (`[jest] ENGINE ABSENT`). Nothing said where they did run, and since the engine left the public repository on 2026-10-23 they had run nowhere.

Run on 2026-10-27 against `main` `1ac50b8`, with the engine copied in from the private source and a local PostgreSQL 16 server: 19 of 20 files passed (560 tests). `test/ledger-watch.e2e-spec.ts` failed 2 of 8, a regression from #32 (2026-10-24) that no run had seen; the fix is on `fix/ledger-watch-boot-jitter`. The drift runs the other way too: `test/evaluation-request-worker.e2e-spec.ts` (#82, not in the list) passes without the engine and fails 1 of 13 with it, because the test fixtures switch source when the engine is present.

Changed: `docs/lab-report-reader.md` says where the 20 run (only by hand, on a machine with the engine), how to run them, and their last result. `docs/ops/ci-cd.md` points to it from "Running the same checks locally". Moving them onto public synthetic fixtures so CI runs them is spec 004.

Not changed: code, tests, the skip list, CI.
