# Chore: re-measure the reader-engine skip list (spec 004, slice 1, local)

Date: 2026-10-27

Slice 1 of [spec 004](../../specs/004-reader-stand-in-coverage/plan.md). The list of backend specs skipped without the report-reader engine (`apps/backend/test/helpers/reader-engine-specs.json`) was measured once, on 2026-10-23, before the stand-in reader and public fixtures D01, D02 and D08 existed. Nothing re-measured it, so specs that now pass without the engine were still skipped in every hosted CI run.

Changed: the 8 files below leave the list (and two of them their `partialSkip` entries), so the list names 12 files and 4 partial skips. `reader-engine.spec.ts` fails when a spec that names the engine's paths or fixture helpers is neither listed nor explained; six of the eight do, so they join its measured exceptions with a dated comment (the guard was seen failing on the shorter list first, then passing 9 of 9). `docs/lab-report-reader.md` gives the new counts.

Measured on `main` `1ac50b8`, engine directories absent, Node 22.22.0, PostgreSQL 16, Moto for S3. Method: a scratch copy of `jest.config.js` (not committed) that keeps the backend's own settings and drops only the engine skip patterns, run in all three tiers.

| File | Tests | Tier 1 (memory store) | Tier 2 (PostgreSQL) | Tier 3 (PostgreSQL + S3) |
| --- | --- | --- | --- | --- |
| `test/db/stored-pgx-preview.pg-spec.ts` | 8 | 8 pass | 8 pass | 8 pass |
| `test/db/evaluation-context.pg-spec.ts` | 4 | 4 pass | 4 pass | 4 pass |
| `test/patient-link.e2e-spec.ts` | 27 | skipped (needs the PostgreSQL record store) | 27 pass | 27 pass |
| `test/lab-pdf-reports.e2e-spec.ts` | 21 | 13 pass, 8 skipped (as above) | 21 pass | 21 pass |
| `test/lab-reports-disputes.e2e-spec.ts` | 20 | skipped (as above) | 20 pass | 20 pass |
| `test/patient-merge.e2e-spec.ts` | 19 | 7 pass, 12 skipped (as above) | 18 pass, 1 skipped | 18 pass, 1 skipped |
| `test/patient-quarantine.e2e-spec.ts` | 10 | skipped (as above) | 10 pass | 10 pass |
| `test/cell-usage.e2e-spec.ts` | 1 | skipped (as above) | 1 pass | 1 pass |

The skips are the specs' own tier conditions, not the engine: the one `patient-merge` test skipped in tiers 2 and 3 checks the memory store's 503 for a merge, and runs in tier 1.

After the change, with the committed configuration, the full local loop passed: root typecheck, lint, `pnpm test`, `test:ci-config`, `check:workflows`, and the three backend tiers with no failures. The `ENGINE ABSENT` line names 12 specs. Each tier runs 228 suites and 3013 tests, against 220 and 2903 before; tier 3 passes 3012, 109 more than before.

Added time: the eight files take 25 s (tier 1), 33 s (tier 2) and 36 s (tier 3) of summed file time, most of it `stored-pgx-preview` (21 s). Jest runs files in parallel, so wall time moved less and within run-to-run noise: 233 to 254 s, 298 to 293 s, 256 to 301 s. One local run each; the hosted time will show on the pull request.

Found: `scripts/check-without-reader.sh --measure` cannot re-measure this list in the public repository. It requires the engine directories to be present (to remove them), and `READER_ENGINE=measure` also switches the stand-in off, so it would measure a different configuration from CI's. The list's note says so. Spec 004 slice 4 replaces it with a CI step.

Not changed: production code, the stand-in, the fixtures, the oracle, the CI workflow and the 12 files still listed (7 need fixtures D03 to D07 and D09 to D12, slice 3; 5 test the engine itself). The run with the engine present was not repeated; `evaluation-request-worker.e2e-spec.ts` still fails 1 of 13 there (slice 2).

Local only until the pull request is opened.
