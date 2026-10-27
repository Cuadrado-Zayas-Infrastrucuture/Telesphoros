# Tasks: spec 005, slice D01a (result reference) only

Derived from the approved [plan.md](plan.md) (D1 to D5, D7, D8 approved 2026-10-27). D01b tasks are written once the founder has edited vocabulary `cdr-v1` (D6).

| # | Task | Requirement | Done when |
| --- | --- | --- | --- |
| T001 | Branch `feat/evaluation-result-reference` off a freshly fetched `main` | D1 | Branch tip equals `origin/main` |
| T002 | Write `apps/backend/test/evaluation-result-reference.e2e-spec.ts` (PostgreSQL tier, public fixture D01, engine-free). It checks that each result's `id` equals the stored `evaluation_results.id`, read through the admin connection; `ordinal` matches the stored order; two reads agree; another tenant gets 404. | FR-001, T01 | The spec fails on `main` for the missing fields, not for the environment |
| T003 | Add `id` and `ordinal` to `evaluationResultDtoSchema`; pass them through in `toEvaluationDto` | FR-001 | T002 passes |
| T004 | Update whole-object expectations and fixtures that build result DTOs, adding the fields without removing any assertion | FR-001 | Every tier green |
| T005 | Consumer compatibility: the strict schema refuses a result without `id`; frontend parsers and the SMART pilot stored-context assembly accept a real response | D1 | Each check fails with the mapper change reverted |
| T006 | T24: the ledger verifies over evaluations created before the change; no projection, hash or migration file changes | R22 | `git diff --stat` shows no migration or ledger file; verify test green |
| T007 | Full local loop: typecheck, lint, test, build, test:infra, test:ci-config, backend default/PostgreSQL/PostgreSQL+S3 tiers, gitleaks | V | Counts recorded; skips listed as skips |
| T008 | `docs/verification/evaluation-result-reference.md`, one status fragment, `docs/lab-report-reader.md` field note | V | `pnpm test:ci-config` green |
