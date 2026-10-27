# Tasks: Run the engine-gated specs in CI on public fixtures and the stand-in reader (RSIC)

**Input**: [spec.md](spec.md), [plan.md](plan.md)

**Prerequisites**: plan.md **approved by the founder** on 2026-10-27 (D1 to D4 as recommended).

**Tests**: Required (SC-001 to SC-005). In each phase the check is seen failing before the change that makes it pass.

**Organization**: One phase per slice, one PR per phase off `main`, never stacked. `[P]` marks tasks that can run in parallel within a phase. Hosted CI is capped at 3 runs per PR.

## Format: `[ID] [P?] [Story] Description`

## Phase 1: re-measure and shrink the list (slice 1)

- [ ] T001 [US1] Run `scripts/check-without-reader.sh --measure` with the stand-in, all three backend tiers; record per-file results in the status note
- [ ] T002 [US1] Remove the 8 group A files from `apps/backend/test/helpers/reader-engine-specs.json` (and their `partialSkip` entries)
- [ ] T003 [US1] Run the full local loop without the engine; confirm the `ENGINE ABSENT` line names 12 files and the 8 run; record the added PostgreSQL-tier time
- [ ] T004 [US1] Status note `docs/status/YYYY-MM-DD-reader-list-remeasured.md`; update the counts in `docs/lab-report-reader.md`

## Phase 2: one fixture source per spec (slice 2)

- [ ] T010 [US3] With the engine present, show `test/evaluation-request-worker.e2e-spec.ts` failing (1 of 13)
- [ ] T011 [US3] Split `FIXTURES` in `apps/backend/test/helpers/lab-pipeline.ts` into `PUBLIC_FIXTURES` and `ENGINE_FIXTURES`; application tests import the public set
- [ ] T012 [US3] Add an explicit real-reader option to `createTestApp`; group C files pass it
- [ ] T013 [US3] Re-run with and without the engine; the T010 spec passes in both

## Phase 3: nine public fixtures (slice 3)

- [ ] T020 [P] [US1] D03 to D07: for each, read the oracle case, write the synthetic text, generate the three files, run the stand-in oracle test
- [ ] T021 [P] [US1] D09 to D12: as T020
- [ ] T022 [US1] Any new stand-in layout: an acceptance test plus a tampered-packet refusal (FR-006)
- [ ] T023 [US1] Remove the group B files from the list, or move their engine-only tests into group C files
- [ ] T024 [US1] Update `data/fixtures/lab-reports/README.md` and `docs/lab-report-reader.md`; status note

## Phase 4: CI keeps the list honest (slice 4)

- [ ] T030 [US2] Add the measure-and-compare step to the backend PostgreSQL job in `.github/workflows/ci.yml`, plus its `.github/ci` guard test
- [ ] T031 [US2] Prove it red: a throwaway branch that adds a group A file back to the list fails CI and names the file (SC-003)
- [ ] T032 [US1] Prove SC-002 once: a throwaway branch that reverts the ledger-watch jitter fix fails CI
- [ ] T033 [US1] Split `subprocess-report-reader.spec.ts`: the 11 engine-free tests run against a scripted fake CLI (FR-005)
- [ ] T034 Status note; `docs/lab-report-reader.md` "Where the 20 run" lists only group C
