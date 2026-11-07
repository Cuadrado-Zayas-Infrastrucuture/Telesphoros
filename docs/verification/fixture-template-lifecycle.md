# Fixture template lifecycle recovery

Date: 2026-11-01. Base: `4062c4258262a4e25e44baf2d247a869272682be`.

The independent fixture repair was recovered from the saved transcript of “Restore MD-a drug list work”. The original local commit `32be316` is not available as a Git object here; these are recovered edits, with new verification rather than an assertion of byte-identical commit recovery. MD-a application source is excluded from this branch.

## Defect and repair

Commit `525e981` changed database fixtures from per-fixture migrations to copies of a migrated template. Two lifecycle controls still injected errors or delay into the removed per-fixture migration connection. On unchanged main the lifecycle command passes 11 of 13 parent controls and fails construction rejection and the abandoned database build control.

The recovered controls target a cold template build and an actual template-copy query. They retain the five-second Jest deadlines, natural-exit assertions, protected unrelated database, session checks and complete inventory assertions. Inventory now includes unfinished `tplbuild_` databases. Migration, connection, publication-after-rename and cancellation failures expose owned template databases left behind by the old helper. The helper immediately closes/drops its owned unfinished database and preserves the original failure together with any cleanup failure.

The recovered construction controls were run against the unchanged helper before applying the repair: the suite failed, reporting leaked `tplbuild_` databases. Later assertions also failed because that leaked state contaminated the inventory. This is a real PostgreSQL defect reproduction, not a dependency-startup failure. Fault injection wraps real connections and SQL; it does not substitute a database result. The end-of-file drain remains unchanged.

## Verification

Fresh command logs are retained outside the repository under `/workspace/verification-gaps/recovered-fixture-*` and `/workspace/verification-gaps/fixture-recovered-*`. Earlier session counts are historical and do not substitute for this recovery's checks.

- All six required commands passed: typecheck, lint/format, workspace tests, build, infrastructure (215), CI configuration (217).
- Workspace memory tests: backend 2,071 passed / 439 service-dependent skips; frontend 652 Vitest tests and 55 script controls; shared types 123, worker 151, AI service 347, SMART pilot 188, CPIC schema 48, jobs 20, fake IdP 7, password notifier 10, root controls 43 passed. Private reader exclusions remain unchanged.
- Recovered construction controls: 10 passed on real PostgreSQL 16. Complete lifecycle matrix: 13 passed, no skipped parent controls, with expected failing children retained.
- The first repaired lifecycle run passed 12 and failed one inventory assertion because global setup reclaimed `tplbuild_f473453045b2`, deliberately leaked by the preceding red control. This failed run is retained as `recovered-fixture-green.log`. The subsequent isolated run from clean inventory passed 13/13 in `recovered-fixture-clean.log`; no assertion or deadline changed.
- Gitleaks 8.30.1 directory scan passed with no leaks and no new suppression. Full service profiles, browser and image rehearsal were not run for this fixture-only branch.

No production application, clinical logic, migration, dependency, CI deadline or required check is changed. The optional private reader is absent. No push, PR, merge or deployment is authorized by this repair.

## Combined recovery verification

On the combined local verification branch with recovered MD-a and migration 0066, typecheck passes, the full PostgreSQL profile passes 4,031 tests (21 intentional skips), and the full PostgreSQL/S3 profile passes 4,051 (one memory-store-only case skipped). The subsequent isolated lifecycle matrix passes 13/13. Both independent patches are preserved separately; the combined branch is verification evidence, not a merged or committed delivery branch. Logs: `/workspace/verification-gaps/combined-*`. FHIR remains blocked by package-server access and is not counted as passing.
