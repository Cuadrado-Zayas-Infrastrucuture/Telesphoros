# Tasks: Asynchronous evaluation requests through the API and the local review page (H4)

**Input**: [spec.md](spec.md), [plan.md](plan.md)

**Prerequisites**: plan.md **approved by the founder** on 2026-10-27 (D1 to D5 as recommended).

**Tests**: Required (SC-001 to SC-005). In each phase the check is seen failing before the change that makes it pass, and each guard is removed once to watch its test fail.

**Organization**: One phase per slice, one PR per phase off `main`, never stacked, kept local until the founder says push. `[P]` marks tasks that can run in parallel within a phase. Hosted CI is capped at 3 runs per PR.

## Format: `[ID] [P?] [Story] Description`

## Phase 1: admission and status routes behind the flag (slice 1)

Done in #119.

- [x] T001 [US3] `env.spec.ts`: `EVALUATION_REQUESTS` defaults to `disabled`; `enabled` is refused without `LAB_REPORT_PIPELINE=enabled`, without a parseable `EVALUATION_EXECUTION_PROFILE`, and when `NODE_ENV=production`; a development configuration with all three is accepted (control)
- [x] T002 [US3] `EVALUATION_REQUESTS` in `apps/backend/src/config/env.ts`, its refinements in the pipeline's block
- [x] T003 [US3] `EvaluationRequestsSwitch` and `RequiresEvaluationRequests()` in `apps/backend/src/lab-reports/evaluation-requests-switch.ts`, mirroring `pipeline-switch.ts`; a unit test of the 503 and the guard order
- [x] T004 [US1] E2E spec on PostgreSQL (`test/evaluation-requests-api.e2e-spec.ts`), written before the routes: admit 202, replay 200 with one job, changed replay 409, `reader` refused to admit with a `clinician` control, status read by `reader`, another tenant 404, malformed id 400, flag off 503 with the job count unchanged
- [x] T005 [US1] `EvaluationRequestsController` with `POST /reports/:id/evaluation-requests` and `GET /evaluation-requests/:id`; `evaluationRequestBodySchema` (`captureId`, `acceptanceId`, `requestId`) in `packages/shared-types`
- [x] T006 [US1] Register the controller and the service in `lab-reports.module.ts`; the service gets the profile from `EVALUATION_EXECUTION_PROFILE` only when the switch is on, after `assertRunsProfile` against the loaded knowledge set and recordings; a start-up test for a mismatched profile
- [x] T007 [US1] SC-001: D01 through HTTP goes `queued` to `completed` with the H3 consumer run in the test process; `GET /evaluations/:evaluationId` returns it
- [x] T008 [US3] Rewrite `test/evaluation-request-boundaries.spec.ts` (D1): only the module and the new controller name the service; `src/main.ts`, `PRODUCTION_JOBS`, `apps/worker`, `infrastructure/` and `.github/workflows/` unchanged; three mutations caught (SC-004)
- [x] T009 Mutations: remove each refinement, the switch guard, and the role decorator once; each is caught
- [x] T010 Full local loop (install, typecheck, lint, the three backend tiers, worker, frontend, `test:ci-config`, gitleaks); status note `docs/status/YYYY-MM-DD-evaluation-requests-api.md`; verification record in `docs/verification/`

## Phase 2: cancel a request that has not started (slice 2)

Cut off `main` without the route (founder, 2026-10-28): the route needs slice 1's controller and moves to phase 3 (T034).

Done in #120. T022 was built as `evaluation_job_cancel(job, request)`, called by an insert trigger on `evaluation_request_cancellations`, rather than a function named `evaluation_request_cancel(uuid)`; the guards are the ones listed.

- [x] T020 Re-read `apps/backend/migrations/` for the next number
- [x] T021 [US2] pg spec first: cancel `queued` and `retry` succeeds; `running`, `completed`, `dead`, `cancelled` give 409; a non-requester gets 403 with a requester control; another tenant 404; cancel then consumer run stores nothing (SC-003); concurrent cancel and claim, exactly one winner per run
- [x] T022 [US2] Migration: `evaluation_request_cancellations` (append-only, forced RLS) and `evaluation_request_cancel(uuid)`, definer owned by the queue's owner role; down refuses while any cancellation exists, run as the restricted migrator
- [x] T023 [US2] Status read maps job `cancelled` to state `cancelled`; `EvaluationRequestDto['state']` gains it; `cancel` on the service and repository
- [x] T025 Mutations on each guard in the function; full local loop; status note and verification record

## Phase 3: the local review page (slice 3)

Done in #131. T033: `docs/lab-report-reader.md` says what H4 adds and does not prove; the H1 plan's "Next scopes" was left unedited, because plans in `docs/design/plans/` are historical records.

- [x] T030 [P] [US1] Component tests first, with a scripted fetch: each state's text, backoff stops at a final state and after 5 minutes, unmount stops polling, a double click replays one `requestId`, the 503 text
- [x] T031 [US1] "Queue synthetic evaluation" in `apps/frontend/src/pages/LocalReviewPage.tsx`: post, poll, show the state, fetch and show the evaluation on `completed`
- [x] T032 [US2] Cancel while `queued` or `retry`
- [x] T034 [US2] `POST /evaluation-requests/:id/cancel` (roles `clinician` and `reviewer`, requester only through the database function) and its e2e cases: 200 with `cancelled`, 409 for a started or finished request, 403 for a non-requester with a requester control, 404 for another organization
- [x] T033 Full local loop including the browser tier; status note; `docs/lab-report-reader.md` and the H1 plan's "Next scopes" say what H4 adds and does not prove (FR-009)
