# Feature Specification: Run the engine-gated specs in CI on public fixtures and the stand-in reader (RSIC)

**Feature Branch**: `docs/spec-004-reader-stand-in-coverage` (spec only; each implementation slice gets its own branch off `main`)

**Created**: 2026-10-27

**Status**: Draft, waiting for the founder's approval of [plan.md](plan.md). On 2026-10-27 the founder chose route B (a stand-in reader plus public synthetic fixtures) over a scheduled run on a maintainer's machine (C) and over fetching the private engine into hosted CI (A).

**Input**: The 2026-10-27 audit of public `main` found that the 20 backend spec files listed in `apps/backend/test/helpers/reader-engine-specs.json` are skipped by every hosted CI run (`[jest] ENGINE ABSENT`) and had run nowhere since the engine left the public repository on 2026-10-23. A run with the engine, the same day, found a regression in one of them that had merged unseen (#32; fixed on `fix/ledger-watch-boot-jitter`). Where they run today is recorded in `docs/lab-report-reader.md` ("Where the 20 run").

Line numbers and counts cite `main` `1ac50b8` with the `fix/ledger-watch-boot-jitter` change applied.

## The problem

- **The skip list is measured once and never again.** It was written on 2026-10-23 by removing the engine and recording what failed. Later that day `6d56486` added the stand-in reader (`apps/backend/test/helpers/stand-in-reader.ts`) and public fixtures D01, D02 and D08 (`data/fixtures/lab-reports/captures`). Nothing re-measured the list, so files that now pass without the engine are still skipped.
- **Measured 2026-10-27, engine absent, nothing skipped, PostgreSQL 16:** of the 20 files, 8 pass in full (109 tests); 7 fail only because public fixtures D03 to D07 and D09 to D12 do not exist; 5 test the engine itself.

  | Group | Files | What they need |
  | --- | --- | --- |
  | A. Pass today | `test/cell-usage.e2e-spec.ts`, `test/db/evaluation-context.pg-spec.ts`, `test/db/stored-pgx-preview.pg-spec.ts`, `test/lab-pdf-reports.e2e-spec.ts`, `test/lab-reports-disputes.e2e-spec.ts`, `test/patient-link.e2e-spec.ts`, `test/patient-merge.e2e-spec.ts`, `test/patient-quarantine.e2e-spec.ts` | Nothing: leave the skip list |
  | B. Need fixtures | `test/lab-reports-capture.e2e-spec.ts` (10 failing), `test/lab-reports-evaluation.e2e-spec.ts` (48), `test/lab-reports-evaluation-negative.e2e-spec.ts` (8), `test/lab-reports-corrections.e2e-spec.ts` (1), `test/ledger-watch.e2e-spec.ts` (1), `test/reports-intake-organization.e2e-spec.ts` (1), `src/lab-reports/runner/fake-text-capture-runner.spec.ts` (17) | Public synthetic fixtures for D03 to D07 and D09 to D12; possibly more stand-in layouts |
  | C. The engine itself | `src/services/report-adapter/adapt-report.spec.ts`, `src/services/report-lookup/lookup.spec.ts`, `src/services/report-reader/handoff-import.spec.ts`, `src/services/report-reader/reader-checkpoint.spec.ts`, `src/services/report-reader/subprocess-report-reader.spec.ts` (11 of 57 tests pass without it) | The engine; they stay off CI |

- **The fixture source flips with the engine.** `FIXTURES` in `apps/backend/test/helpers/lab-pipeline.ts:18` is the engine's captures when the engine is present and the public ones otherwise. A spec written against one set fails against the other: `test/evaluation-request-worker.e2e-spec.ts` (#82) passes 13 of 13 without the engine and fails 1 of 13 with it (it expects a drug only the public D01 has). So a run with the engine is not a superset of a run without it.

**Threat.** A change to the ledger, the records, evaluation, disputes or corrections breaks behaviour that only these specs check, and merges because CI skips them (it has happened once, #32). Second, a "with engine" check reports red for reasons unrelated to the change, which teaches people to ignore it.

**Rule:** a spec runs in hosted CI unless it tests the engine itself. A spec that needs the engine says so in a list that is re-measured by CI, not by hand.

## Out of scope (v1)

- Real PDF extraction, the engine's accuracy, or the engine's own fixtures. The stand-in says nothing about the real reader (its header says so) and nothing here changes that.
- Bringing the engine, its fixtures or anything derived from them into the public repository, or into hosted CI by any route. Their provenance is with counsel.
- Group C beyond splitting out tests that need no engine. Where group C runs stays as recorded in `docs/lab-report-reader.md`.
- Any change to production code, the adapter's checks, the rules engine or clinical behaviour.

## User Scenarios & Testing

### User Story 1: a change that breaks the ledger, records or evaluation fails CI (Priority: P1)

A contributor changes the ledger monitor, the record repositories or the evaluation path. Today the specs that drive these end to end are skipped. After this feature, CI runs them on public fixtures and the change fails CI if it breaks them.

**Independent test**: revert the `fix/ledger-watch-boot-jitter` change on a branch; CI's backend tier fails on `ledger-watch.e2e-spec.ts`.

**Acceptance scenarios**:
1. **Given** groups A and B on `main`, **when** CI runs the backend tiers without the engine, **then** none of those 15 files is skipped and the `ENGINE ABSENT` line names only group C.
2. **Given** a change that breaks any group A or B spec, **when** CI runs, **then** the backend tier fails.

### User Story 2: the skip list cannot go stale (Priority: P1)

A contributor adds a public fixture or stand-in layout that makes a listed spec pass. Today nothing notices. After this feature, CI fails when a listed file passes without the engine, and when an unlisted file fails without it.

**Independent test**: add a group A file back to the list; CI fails and names it.

### User Story 3: a run with the engine is a superset of a run without it (Priority: P2)

A maintainer with the engine runs the backend tiers. Every spec that passes in CI also passes there, and group C runs too.

**Independent test**: with the engine present, `evaluation-request-worker.e2e-spec.ts` passes 13 of 13.

### Edge cases

- A public fixture with the same id as an engine fixture names different bytes. Nothing may compare them or treat one as evidence about the other.
- The stand-in rejects a layout it does not know. A fixture that needs a new layout extends the stand-in, with a test that the adapter still refuses a tampered packet.
- A group B file has tests that only make sense against the engine (real extraction quirks). Those move to a group C file instead of being weakened.

## Requirements

### Functional Requirements

- **FR-001**: Public synthetic fixtures exist for D03 to D07 and D09 to D12, each matching what the hand-written oracle (`tests/report_adapter/golden.json`) expects for that id, produced by the existing generator (`scripts/test-fixtures/lab-report-fixtures.cjs`), with no patient data and no content taken from the engine's fixtures.
- **FR-002**: The application tests read the public fixtures always. Specs that test the engine read the engine's fixtures explicitly. No helper chooses the set by checking whether the engine is present.
- **FR-003**: The skip list names only group C files, and those are skipped only when the engine is absent.
- **FR-004**: CI re-measures the list on every run that touches the backend: a listed file that passes without the engine, or an unlisted file that fails only for want of it, fails the job.
- **FR-005**: Group C files are split so their engine-free tests (for example 11 of 57 in `subprocess-report-reader.spec.ts`) run in CI.
- **FR-006**: Every new stand-in layout has a test that the real adapter accepts the packet and refuses a tampered copy, as the existing stand-in tests do.
- **FR-007**: `docs/lab-report-reader.md` and `data/fixtures/lab-reports/README.md` describe each fixture and say what the stand-in does not prove.

### Key Entities

- **Public fixture**: `data/fixtures/lab-reports/captures/Dnn/{source.pdf, report.txt, capture.json}`; synthetic; its id matches an oracle case, not an engine file.
- **Skip list**: `apps/backend/test/helpers/reader-engine-specs.json`; after this feature, group C only.
- **Oracle**: `tests/report_adapter/golden.json`; hand-written; unchanged by this feature.

## Success Criteria

- **SC-001**: In a hosted CI run without the engine, the `ENGINE ABSENT` line names 5 files or fewer, all from group C.
- **SC-002**: Reverting the ledger-watch jitter fix on a branch makes hosted CI fail. Checked once, on a throwaway branch, before the slice that wires the guard is merged.
- **SC-003**: Adding a group A file back to the skip list makes CI fail and name the file.
- **SC-004**: With the engine present locally, every spec that passes in CI passes (no fixture-source failures).
- **SC-005**: No file under `src/` imports the stand-in or a test helper (the existing guard stays green).

## Assumptions

- ASSUMPTION: the oracle's expectations for D03 to D12 can each be met by a synthetic document in the stand-in's line format, perhaps with one or two new layouts. Alternative if not: an id whose case needs real extraction behaviour is dropped from the public set and its tests move to group C.
- ASSUMPTION: CI's backend tiers have the time budget for about 300 more tests (109 in group A, 194 in group B; most are end-to-end against PostgreSQL). To be measured in slice 1.
