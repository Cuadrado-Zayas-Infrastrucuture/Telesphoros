# Evaluations may rest on a stored structured revision (032 S3, PR 2a)

Date: 2026-11-03

An evaluation can now rest on a stored structured laboratory revision instead of an accepted PDF capture. Nothing creates one yet: no route and no service writes a structured evaluation, and the evaluation read and decision routes still need the report-reader pipeline, which staging does not run. This slice only widens the storage and the ledger so the next slice can write one. Migration 0070 is labelled `compat: breaking` because the ledger verifier must read an evaluation without a capture before any such row is written.

What changed: `evaluations.capture_id` is nullable; `source_kind` (default `pdf-capture`, kept so running writers still insert) and `structured_revision_id` are added with a check that names exactly one source; hold codes are tied to the source kind; `evaluations_check` and `data_provenance_check()` accept a structured revision as the parent; a structured evaluation's ledger projection carries its source and a PDF evaluation's projection, and so its hash, is unchanged; `EvaluationDto.captureId` may be null.

Verification, on PostgreSQL 16.15 with scram passwords, Moto 5.2.4, Node 22.22.0, pnpm 10.28.0:

- New spec `evaluation-structured-source.e2e-spec.ts`, 4 passed: a structured evaluation stores with no capture, reads back through the repository view, mapper and public schema, and the ledger walk is clean; it is idempotent; refusals name their cause. Changing `structured_revision_id` afterwards makes the walk fail, and that test goes red when the projection fields are removed.
- Down-guard: a new test as the non-superuser migrator refuses to drop a populated structured evaluation, then reverses cleanly and re-applies. The existing 0069 down-guard test now steps back past newer migrations first.
- Backend tiers 1, 2 and 3: 3381, 4030 and 4105 tests passed, with 726, 77 and 2 skipped. Each tier also reported 37 failures, all in the three recovery suites (they start their own PostgreSQL server, which the sandbox this ran in denies); those suites passed 37 of 37 when run on their own outside it.
- Worker 247 passed (20 files); frontend 727 passed (67 files); root `pnpm test` 47 passed; `test:infra` 300 passed; `test:ci-config` 221 passed; fixture lifecycle 13 passed; the reader-engine skip list still matches; `typecheck`, `lint`, `build`, `check:chunks`, `knowledge:verify --production`, `check:workflows` and gitleaks passed.

Not run: the published FHIR IG validation (needs Java 21 and network), the browser and image tiers, hosted CI, and any HTTP read of an evaluation, because the report-reader engine is absent from the public repository and those routes need the pipeline. Next: PR 2b (the assessment service) and PR 3 (staging enablement, including a read path that does not depend on the pipeline flag). Plan: `docs/design/plans/pgx-synthetic-assessment.md` once it is merged.
