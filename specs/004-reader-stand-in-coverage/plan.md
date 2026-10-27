# Implementation Plan: Run the engine-gated specs in CI on public fixtures and the stand-in reader (RSIC)

**Branch**: `docs/spec-004-reader-stand-in-coverage` | **Date**: 2026-10-27 | **Spec**: [spec.md](spec.md)

**Status**: Approved by the founder on 2026-10-27, with D1 to D4 as recommended: *"Approve spec 004 plan.md with D1-D4 as recommended. Start slice 1 on its own local branch."*

## Summary

Four slices, each one PR off `main`. Slice 1 is pure measurement and list maintenance and brings 8 files (109 tests) into CI at once. Slice 2 makes the fixture source explicit so a run with the engine is a superset of one without. Slice 3 writes the nine missing public fixtures and brings the other 7 files in. Slice 4 makes CI re-measure the list so it cannot go stale again.

## Technical Context

- **Code touched**: `apps/backend/test/helpers/{reader-engine-specs.json, reader-engine.cjs, lab-pipeline.ts, stand-in-reader.ts}`, the group B and C spec files, `scripts/test-fixtures/lab-report-fixtures.cjs`, `data/fixtures/lab-reports/`, `scripts/check-without-reader.sh`, `.github/workflows/ci.yml` (slice 4 only).
- **Not touched**: anything under `apps/backend/src/` (the guard in `test/stand-in-reader.spec.ts` enforces that the stand-in stays out), the oracle `tests/report_adapter/golden.json`, the engine.
- **Runner**: Jest backend tiers as CI runs them (default, PostgreSQL, PostgreSQL + S3), Node 22.22.0, PostgreSQL 16.
- **Measurement method**: the one used for this spec. Engine directories absent, the skip list set to empty in a scratch copy of `jest.config.js` (never committed), all three tiers, `--json` output grouped by file and by missing path.

## Constitution Check

| Principle | Result |
|---|---|
| I. Plan first, approved by the founder | Passes once this plan is approved; `tasks.md` is derived from it. |
| II. Synthetic data only | Passes: FR-001 fixtures are original and synthetic, written from the oracle, never from the engine's files; the README states it. |
| III. Inbound content is untrusted data | Not affected: the stand-in reads fixture text the repository wrote. |
| IV. Tests earn their keep | Passes: every slice shows its check failing first (SC-002, SC-003), and each new layout has a refusal control (FR-006). |
| V. Report outcomes faithfully | Each slice's status note records counts, what was skipped, and the tier that did not run. |

**Gate result**: passes, with no exception to a standing rule.

## Design

### Slice 1: re-measure and shrink the list (FR-003, part)

Run `scripts/check-without-reader.sh --measure` with the stand-in in place and remove the 8 group A files from `reader-engine-specs.json`. `reader-engine.spec.ts` already fails if the list names a missing file; nothing else changes. Measure the added CI time on the PostgreSQL tier and record it.

### Slice 2: one fixture source per spec (FR-002, User Story 3)

Replace the presence switch in `lab-pipeline.ts` with two named exports: `PUBLIC_FIXTURES` (default for application tests) and `ENGINE_FIXTURES` (imported only by group C files). `createTestApp` keeps choosing the stand-in when the engine is absent, and gains an explicit option to use the real reader, which only group C passes. Proof: `evaluation-request-worker.e2e-spec.ts` passes with the engine present.

### Slice 3: nine public fixtures (FR-001, FR-006, FR-007)

For each of D03 to D07 and D09 to D12: read the oracle case, write the smallest synthetic document in the stand-in's format that produces it, generate `source.pdf`, `report.txt` and `capture.json` with the existing generator, and run the stand-in's oracle test over it. Where a case needs a layout the stand-in lacks (a held reason it cannot produce yet), add the layout with an acceptance test and a tampered-packet refusal. Then remove the group B files from the list, or move their engine-only tests into group C files. Order: the cases the most failing tests need first (evaluation, then capture, then the rest).

### Slice 4: CI keeps the list honest (FR-004, User Story 2)

Add a step to the existing backend PostgreSQL job, after the tier passes: run `check-without-reader.sh --measure` against the list and fail on any difference. It runs in the existing job, so no new required check and no ruleset change. Prove it red first: a branch that adds a group A file back to the list must fail (SC-003).

### Group C (FR-005)

Split `subprocess-report-reader.spec.ts` so the 11 engine-free tests (deadlines, process-group kill, source limit, refusal shapes) run against a scripted fake CLI in every CI run. The other four group C files stay engine-only and keep the manual run recorded in `docs/lab-report-reader.md`.

## Founder decisions (only the founder can make these)

| # | Decision | Recommendation |
|---|---|---|
| D1 | Approve slices 1 to 4 in this order | Yes. Slice 1 is the smallest and brings 109 tests into CI at once. |
| D2 | Who checks the nine new fixtures against the oracle | The oracle test does it mechanically; no pharmacist review is needed because the fixtures carry no clinical content (as D01, D02, D08). Say so if you want to review them. |
| D3 | If a case cannot be met synthetically, drop it from the public set (its tests become group C) or extend the stand-in further | Drop it, and record why, rather than grow the stand-in into a second reader. |
| D4 | Slice 4's measure step costs CI minutes on every backend run | Accept it, within the $1.44 per-run planning cap; measured in slice 1. |

## Not touched by this plan or its PRs

Production code, the engine and its fixtures, the oracle, the required checks and the ruleset, the clinical hold.

## Complexity Tracking

None. Every slice extends something that exists: the stand-in, the generator, the measure script and an existing CI job.
