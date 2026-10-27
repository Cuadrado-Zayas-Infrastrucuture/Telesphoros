# Implementation Plan: clinician result decisions (CDR), slices D01a and D01b

**Branch**: `docs/data-products-d00` (this plan) | **Date**: 2026-10-27 | **Spec**: [spec.md](spec.md)

**Status**: **Awaiting founder approval.** No code, migration or script has been written. `tasks.md` is written from this plan once it is approved (spec-driven workflow, step 3).

## Summary

Two slices, each one draft PR off `main`, in this order. The report's single D01 vertical slice is **split** because the coupling differs:

- **D01a, result reference.** Two fields on an existing DTO and the mapper. No migration and no hash change, because the stored result UUID is already in the ledger projection (`apps/backend/src/ledger/projections.ts:199`).
- **D01b, clinician result decisions.** A new ledgered record kind. Its migration widens the ledger's event-type constraints (the 0021 pattern), adds two keys to existing tables, and touches six catalog/inventory tests. It is `breaking` under the migration lint.

D01b depends on D01a only for the public `id`. It does not depend on its code, so D01b branches off `main` after D01a merges.

## Technical context

- **Stack**: NestJS backend, shared Zod contracts, PostgreSQL 16 with forced RLS, the per-tenant hash-chained ledger. Ledger records are PostgreSQL only (`apps/backend/src/storage/storage.module.ts:40-41`), so the behaviour tests run on the PostgreSQL tiers.
- **Reused, not rebuilt**:
  - `withTenant` and `app_tenant()`/`app_actor()`
  - `membership_assert_current()` (`0017:73`)
  - `ledger_append` and its `ledger_heads FOR UPDATE` lock, plus the post-lock re-check pattern (`ledger-records.repository.ts:495-531`)
  - the body `requestId` convention (`0045`, `disputes.service.ts:60-76`)
  - `event_notes` and `GET /notes/:id`
  - the corrections chain indexes (`0009:45-46`)
  - `LabPipeline.reviewedCapture` with public fixture D01 and the stand-in reader (`test/helpers/lab-pipeline.ts:170`)
  - `Session`/`untilBlocked` barriers (`test/helpers/barrier.ts`)
  - the restore suites
- **In flight**: PR #94 edits `ledger-records.repository.ts`. D01b therefore puts its SQL in a **new** repository file and adds only its type to the shared ledger lists.

## Constitution check

| Principle | Result |
| --- | --- |
| I. Plan first | Passes once approved |
| II. Synthetic only | Passes: public fixture D01 only; routes behind the pipeline switch, refused in production |
| III. Inbound content is data | Passes: a note is stored as data, never interpreted; T26 checks a hostile note changes nothing |
| IV. Tests earn their keep | Every refusal has a succeeding control; each guard gets a mutation (table below); PostgreSQL and PostgreSQL+S3 tiers |
| V. Report faithfully | Verification record in `docs/verification/`, with engine-gated skips listed as skips |

No exception to a standing rule.

## Founder decisions (only the founder can make these)

| # | Decision | Recommendation |
| --- | --- | --- |
| D1 | Split into D01a then D01b, two draft PRs | **Yes.** D01a is small and safe; D01b carries the ledger migration. |
| D2 | Who may record a decision | **`clinician` only.** Reviewer-only and admin users are refused. A person with both roles may record one. |
| D3 | Which basis is eligible, checked at commit under the ledger lock | **Evaluation active and current, report not quarantined, result outcome `shown`, no dispute in force on its cited cell** (same guideline id, version, file hash and locator). `no-published-recommendation`, held, abstained and no-guideline results are not decision opportunities in this slice. A decision committed before a later retraction stays as history. |
| D4 | Revision rule | **One linear history per result, across clinicians.** A new decision must name the current head (`previousDecisionId`); a stale head is 409 `decision-stale`. The alternative, one history per clinician per result, makes "the current decision" ambiguous for later metrics. |
| D5 | `occurredAt` window | **Between the evaluation's `createdAt` and the commit time.** No future times; no date-only precision in this slice. |
| D6 | Reason codes and note | **The eight codes in [data-model.md](data-model.md#2-new-table-clinician_result_decisions-migration-0052)**, required unless `accepted`. A note is optional, except for `other-documented`. You validate the list as clinical owner; changing it later is a new migration. |
| D7 | Name and response values | **"Clinician result decision"** with `response` ∈ accepted, modified, rejected, deferred, clarification-requested. `disposition` is taken by the engine. |
| D8 | Roadmap metric | Record now that the H1 "outcome recorded" gate is **not** computed from decisions. Until D03/D04 exist, report it only as "decision recorded on N of M shown results" (synthetic). |

Out of scope and **not** asked here: PharmCAT versus the in-house engine (the roadmap conflicts with D1 = A on record; [spec](spec.md#alignment-with-the-company-roadmap-founder-document-2026-10-24)), consent design (D05), any UI.

## Slice D01a: result reference

**Files (allowlist)**:
- `packages/shared-types/src/lab-report.ts`: `evaluationResultDtoSchema` gains `id: z.uuid()` and `ordinal: z.number().int().min(0)`.
- `apps/backend/src/lab-reports/lab-report.mapper.ts`: passes both fields through.
- `apps/backend/src/lab-reports/lab-report.mapper.spec.ts`
- `apps/backend/test/evaluation-result-reference.e2e-spec.ts` (new, PostgreSQL tier, engine-free)
- Expectations that compare whole result objects, updated by adding the fields (no assertion removed). Found by `rg -l recommendationText`; confirmed when tests run:
  - `packages/smart-pilot/test/stored-pgx.test.js`
  - `apps/backend/test/lab-reports-evaluation.e2e-spec.ts` (engine-gated)
  - `apps/backend/test/cell-usage.e2e-spec.ts`
  - `apps/backend/test/lab-reports-disputes.e2e-spec.ts`
  - frontend page tests if they build result fixtures
- `docs/lab-report-reader.md` (the field list), `docs/status/2026-10-2x-evaluation-result-reference.md`, `docs/verification/evaluation-result-reference.md`

**Not touched**: migrations, projections, the verifier, record hashes, the engine, any knowledge file, the smart-pilot snapshot or FHIR output.

**Tests**:
- `id` equals the stored `evaluation_results.id`, read through the admin connection as an independent oracle.
- `ordinal` matches the stored order.
- Two reads return the same ids.
- Another tenant's evaluation is 404.
- **T24**: the ledger verifies over evaluations created before the change (the ledger golden SQL spec is unchanged).

## Slice D01b: clinician result decisions

**Migration `0052_clinician_result_decisions`** (`-- compat: breaking`, `lock_timeout 2s`, `statement_timeout 30s`):
- the table and keys in [data-model.md](data-model.md)
- `UNIQUE (id, evaluation_id, tenant_id)` on `evaluation_results` and `UNIQUE (id, tenant_id, patient_id)` on `evaluations`
- a BEFORE INSERT check binding `app_tenant()`/`app_actor()`, the evaluation time window and the note rule
- the append-only, no-truncate and `_has_event` triggers
- the ledger event type `clinician-result-decision` added to both `ledger_events` CHECKs and to `ledger_event_row_exists()` (the 0021 shape, run as `telesphoros_ledger`)
- policies and grants as 0021

**Down migration**: refuses when any decision exists unless `telesphoros.allow_clinician_decision_drop=yes` (the 0045 shape), then restores the 0051 ledger constraints and function.

**Files (allowlist)**:
- `apps/backend/migrations/0052_clinician_result_decisions.{up,down}.sql`
- `packages/shared-types/src/clinician-decisions.ts` (new; exported from the package index)
- `apps/backend/src/lab-reports/clinician-decisions.{controller,service}.ts` (new); registration in `lab-reports.module.ts`
- `apps/backend/src/storage/postgres/clinician-decisions.repository.ts` (new). It holds the insert and the post-lock re-check, and reuses the current-evaluation, quarantine and dispute queries by import or by a narrow shared helper. It does not edit the functions #94 changes.
- `apps/backend/src/ledger/{ledger-types,projections}.ts`, `apps/backend/src/db/append-only-tables.ts`
- the inventories that must list the new table, each extended without removing an assertion:
  - `test/db/ledger-catalog.pg-spec.ts`
  - `test/helpers/schema-acceptance.ts`
  - `test/db/tenant-binding.pg-spec.ts`
  - `test/db/down-guards-as-migrator.pg-spec.ts` (head 0051 → 0052)
  - `fk-indexes` and `ledger-golden-sql` specs if they enumerate tables
  - `docs/ops/api-hosting.md` if it lists record tables
- `apps/backend/test/clinician-decisions.e2e-spec.ts` and `apps/backend/test/db/clinician-decisions.pg-spec.ts` (new)
- `docs/design/records-and-corrections.md` (a new amendment section 24; earlier sections untouched), `docs/auth.md` (role table row)
- `docs/status/…-clinician-result-decisions.md`, `docs/verification/clinician-result-decisions.md`

**Not touched**:
- the engine, outcomes, holds, corrections, disputes and capture decisions
- `evaluations`/`evaluation_results` rows, which receive two unique keys only
- the evaluation DTO beyond D01a
- the AI service and its receipts
- the frontend, Terraform and CI configuration

**Tests** (PostgreSQL tier through the HTTP API, plus a database spec for the constraints; expected values written by hand):

| ID | Scenario | Expected |
| --- | --- | --- |
| T01 | Another tenant's result; same-tenant result of another patient (body names the wrong `patientId`); result with a mismatched `evaluationId`; a direct INSERT as the app role with a mismatched patient | 404; 409 `decision-binding-mismatch`; 409; FK violation. No row and no ledger event in each case. **Control**: the correct binding stores 201. |
| T02 | Two identical requests with one `requestId`, released together by barrier | One row, one ledger event; both answers carry the same id (201 and 200) |
| T03 | Same `requestId`, different `response` | 409 `request-id-reused`; the original is unchanged |
| T04 | Membership revoked before commit (barrier between lookup and append) | No row; the error the current membership contract gives; control: unrevoked commits |
| T05a | Retraction commits first, then a decision | 409 `decision-basis-unavailable`, no row |
| T05b | Decision holds the ledger lock, a retraction waits (`untilBlocked`), then both commit | Decision stored; history shows `basis: ["retracted"]`; the decision row is unchanged |
| T05c | Same two orderings for a dispute raised on the cited cell and for a patient-link rejection | Same pattern |
| T05d | A `held` result, a superseded evaluation, a non-current evaluation | 409 `decision-basis-unavailable` each |
| T06 | A capture accepted, an evaluation made, no decision | History is empty and `currentDecisionId` is null |
| T07, T08 | Engine `shown` and an `accepted` decision | No presentation, order or implementation field exists in any response (contract test on the DTO keys) |
| T09 | A retried POST after a dropped response | One row (same as T02, sequential) |
| Chain | Two concurrent revisions of one head | One stored, the other 409 `decision-stale`; a revision naming a decision on another result is refused by the FK |
| Rules | `rejected` with no reason; `other-documented` with no note; `occurredAt` before the evaluation or in the future; duplicate codes; unknown code | 400 each; control: valid forms store |
| Roles | reader, reviewer-only, admin-only | 403; clinician and clinician+reviewer store |
| Notes | A note is readable by a clinician and a reviewer through `GET /notes/:id`, not by a reader; the ledger event holds only its hash | as stated |
| T24 | Migrate 0051 → 0052 on a database with ledgered evaluations; verify the whole ledger | Verifies; projections of old rows are unchanged |
| T25 | Backup and restore with decisions present, restored under the restricted roles | Rows, grants, policies and the ledger chain survive; the restore ledger check passes |
| T26 | A note containing instructions or SQL-looking text | Stored as text; no other effect |
| T30 | The engine-gated specs | Reported as skipped (ENGINE ABSENT), never as passed |

**Mutation checks** (each removed in a scratch copy, its test seen failing, then restored):
- the role decorator
- either composite FK
- the post-lock basis re-check
- the request-hash comparison
- the chain unique index
- the `occurred_at` CHECK
- the BEFORE INSERT actor binding

## Verification and rollout

- **Commands, run locally** (Node 22.22.0, PostgreSQL 16 tools first on PATH, Moto on its own port):
  - `pnpm install --frozen-lockfile`
  - `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`
  - `pnpm test:infra`, `pnpm test:ci-config`
  - the backend default tier, `TEST_STORAGE=postgres`, and `TEST_STORAGE=postgres TEST_OBJECT_STORAGE=s3`
  - the worker tests only if a job file changes (none is planned)
  - gitleaks 8.30.1 over the branch
  - the frontend Playwright suites are not affected (no UI change); they run anyway as part of `pnpm test` where configured, and are reported.
- **Rollout**: local branches, draft PRs only once you say push. No deployment, no AWS. The pipeline switch keeps the routes off by default and refused in production.
- **Rollback**:
  - D01a reverts cleanly, since no data is involved.
  - D01b's down migration refuses when decisions exist. Forward repair (a new migration) is the path for a populated database.

## Next bounded slice after D01b

**D02 presentation events**, once you define what "presented" means (delivered, rendered, opened or acknowledged). Alternatively, **D05 eligibility design** as a plan-only slice, since it gates every release and needs counsel input early.
