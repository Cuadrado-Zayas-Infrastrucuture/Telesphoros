# Feature Specification: Asynchronous evaluation requests through the API and the local review page (H4)

**Feature Branch**: `docs/spec-007-async-evaluation` (spec only; each implementation slice gets its own branch off `main`)

**Created**: 2026-10-27

**Status**: Approved 2026-10-27 ([plan.md](plan.md), D1 to D5 as recommended). Scope set by the founder on 2026-10-27: *"write spec 006 for H4 behind a flag that is off by default and refused in production; the worker binding stays a separate decision"*. Renumbered from 006 on 2026-10-28 at the founder's choice: open PR #109 already names the clinician-decision-records spec "spec 006"; quotations keep the founder's words as given.

**Input**: H4 of the engine harness sequence ([H1 plan](../../docs/design/plans/engine-durable-admission.md), "Next scopes"). H1 (PR 80, migration 0050) stores an evaluation request and its queue job. H2 (PR 81) makes a read cancellable through an `AbortSignal`. H3 (PR 82, migration 0051) adds a fenced worker that completes requests. None of them is reachable from the API or the UI.

Line numbers cite `main` `56ef77c`.

## The problem

- **Evaluation is synchronous.** `POST /reports/:id/evaluations` (`apps/backend/src/lab-reports/evaluations.controller.ts:31`) holds the HTTP request open while the reader runs, and passes no abort signal (`:40`). A slow read ties up a connection and the caller's tab, and the caller cannot stop it.
- **The durable path has no door.** `EvaluationRequestsService` (`apps/backend/src/lab-reports/evaluation-requests.service.ts:8`) is "deliberately absent from Nest modules, controllers and production consumers", and `test/evaluation-request-boundaries.spec.ts:11-14` fails if any module or controller names it. Only tests construct it.
- **A request cannot be cancelled by the person who asked.** The only cancel is the operator CLI (`apps/backend/src/jobs/jobs-cli.ts:122-131`), which cancels a job that has not started. No SQL function or `JobQueue` method cancels a job, and the status read turns a cancelled job into a 503 (`apps/backend/src/storage/postgres/evaluation-requests.repository.ts:139-144`), because `cancelled` is not one of its states.
- **The API has no execution profile.** Admission pins a profile (`evaluationExecutionProfileSchema`, `packages/shared-types/src/evaluation-request.ts:5-11`). Only the worker loads one, from `EVALUATION_EXECUTION_PROFILE` (`apps/backend/src/lab-reports/evaluation-worker-config.ts:52`), checked against what it loaded (`:73-75`).

**Rule:** the queued path is reachable only where the flag is on, never in production, and never without the same eligibility, tenant and role checks as H1. Nothing about it says an evaluation is clinically valid.

## Out of scope (v1)

- **How a background worker acts.** The H3 worker acts for the requesting person through the tenant binding the tests use. A capability-mode binding for a background worker is a separate founder decision, required before any real data. H4 does not design, change or depend on it.
- Running the worker as a deployed service, `PRODUCTION_JOBS`, the worker app's registrations, schedules, outbox routes, infrastructure or CI workflows. The worker still runs only from `start:evaluation-worker`, by hand, locally.
- Cancelling a job that has already started. H2's abort is driven by the job runner (lease loss, timeout, shutdown); a user cancel of a running read needs a fence the worker checks, which is H5 or later.
- Shared capacity, queue-depth limits and throughput (H5).
- Any model, provider, inference adapter, clinical rule, hold, or golden (D01 to D12).
- The synchronous route. It stays as it is; nothing is deprecated.
- Production UI. The only UI is the local review page, which already runs only in development on `127.0.0.1` (`apps/frontend/src/pages/LocalReviewPage.tsx:44-58`).

## User Scenarios & Testing

### User Story 1: queue an evaluation and get it back later (Priority: P1)

A clinician or reviewer on the local review page queues an evaluation of an accepted capture. The page answers at once with a request id and a state, keeps checking, and shows the stored evaluation when the worker completes it. Reloading the page or retrying the same click does not queue a second one.

**Independent test**: with the flag on, the pipeline on and the H3 consumer running in the test process, `POST` a request for public fixture D01, read `queued`, run one job, read `completed` with an `evaluationId`, and `GET /evaluations/:id` returns the evaluation.

**Acceptance scenarios**:
1. **Given** the flag on and an eligible capture, **when** a clinician posts a request, **then** the API answers 202 with the request (`state: queued`) and one job exists.
2. **Given** the same body with the same `requestId`, **when** it is posted again, **then** the API answers 200 with the same request and no second job.
3. **Given** the same `requestId` with a different capture or acceptance, **then** the API answers 409 `idempotency-conflict`.
4. **Given** a completed request, **when** anyone with a clinical-read role reads it, **then** the state is `completed` and `evaluationId` names an evaluation they can read.

### User Story 2: cancel a request that has not started (Priority: P2)

The person who queued a request changes their mind before a worker picks it up and cancels it. The request reads as `cancelled`, and no worker evaluates it.

**Independent test**: queue a request, cancel it, run the consumer; nothing is evaluated, and the status reads `cancelled`.

**Acceptance scenarios**:
1. **Given** a `queued` or `retry` request, **when** its requester cancels it, **then** the API answers 200 with `state: cancelled`.
2. **Given** a `running`, `completed`, `dead` or `cancelled` request, **when** anyone cancels it, **then** the API answers 409 and nothing changes.
3. **Given** a request someone else queued, **when** a member who is not its requester cancels it, **then** the API answers 403 (see plan D3).

### User Story 3: nothing is reachable where the flag is off (Priority: P1)

An environment that has not turned the flag on, including every production configuration, has no queued path.

**Independent test**: with the flag off, each new route answers 503 and creates nothing; with `NODE_ENV=production` and the flag on, the API refuses to start.

### Edge cases

- The capture, acceptance or patient link changes after admission. Status still reads the historical request (H1 already does this); a new admission rechecks eligibility.
- The API's configured profile differs from the worker's. The worker refuses the request without reading it (H3); the request ends `dead` and the page says so. The API checks its profile against what it loaded at start-up, as the worker does.
- A requester loses access while queued. H3 already stores nothing; the request ends `dead` or `retry`, never `completed`.
- A job succeeds without a completion receipt: `completion-missing`, shown as an operational state, never as a clinical result or a hold.
- The page polls a request that will never finish (no worker running). Polling backs off and stops after a bounded time with a plain message; it never infers a result.
- Another tenant's request id: 404, the same as a missing one.

## Requirements

### Functional Requirements

- **FR-001**: A new setting `EVALUATION_REQUESTS` (`disabled` | `enabled`, default `disabled`) in `apps/backend/src/config/env.ts`. `enabled` needs `LAB_REPORT_PIPELINE=enabled` and a valid `EVALUATION_EXECUTION_PROFILE`, and is refused when `NODE_ENV=production`, in the same refinement block as the pipeline's refusal (`env.ts:209-220`).
- **FR-002**: `POST /reports/:id/evaluation-requests`, body `{ captureId, acceptanceId, requestId }` (all uuid, strict), roles `clinician` and `reviewer`, calls H1's `admit` with the API's profile. 202 with the request when created, 200 on an identical replay, 409 on a changed replay, and H1's existing refusals otherwise.
- **FR-003**: `GET /evaluation-requests/:id`, clinical-read roles, returns H1's `EvaluationRequestDto`; 404 for a missing or other-tenant id.
- **FR-004**: `POST /evaluation-requests/:id/cancel`, requester only, cancels a request whose job is `queued` or `retry`, in one transaction, through a new narrow database function (migration, plan §Slice 2). Anything else is 409. The status read gains the state `cancelled`.
- **FR-005**: Every new route sits behind the pipeline guard and a second guard for `EVALUATION_REQUESTS`; flag off answers 503 before the body is read, as `RequiresPipeline` does (`apps/backend/src/lab-reports/pipeline-switch.ts:31-45`).
- **FR-006**: The API loads its profile from the same `EVALUATION_EXECUTION_PROFILE` and refuses to start if it names a knowledge set or recordings the API did not load (`assertRunsProfile`, `evaluation-worker-config.ts:73`). No caller-supplied profile, provider or model setting is accepted.
- **FR-007**: The local review page offers "Queue synthetic evaluation" next to the existing button. It shows the state as a word, polls with backoff while the state is `queued`, `running` or `retry`, stops at any other state or after a bounded time, offers Cancel while cancellable, and shows the stored evaluation once `completed`. It says plainly that nothing is clinically valid, as the page does today.
- **FR-008**: The boundary test is rewritten on purpose, not loosened: the service may appear only in the module that registers the new controller, and only behind the flag; the consumer stays out of `src/main.ts`, `PRODUCTION_JOBS`, the worker app and every deployment and workflow file.
- **FR-009**: Status notes and `docs/lab-report-reader.md` (or the H1 plan's "Next scopes") describe what H4 adds and what it does not prove.

### Key Entities

- **Evaluation request** (`evaluation_requests`, 0050): immutable, append-only; H4 adds no column to it.
- **Queue job** (`jobs`, 0023): carries only `requestId`; H4 moves a not-started job to `cancelled` through the new function.
- **Cancellation record**: who cancelled and when, stored where the plan's D4 decides; never by updating the request row.

## Success Criteria

- **SC-001**: On real PostgreSQL, through the HTTP app, D01 goes `queued` to `completed` with the H3 consumer in process, and a replay creates no second job.
- **SC-002**: With the flag off, every new route answers 503 and the job count is unchanged; a production configuration with the flag on refuses to start. Each shown failing first by removing its guard.
- **SC-003**: A cancelled request is never evaluated: the consumer run after a cancel stores no evaluation and no completion.
- **SC-004**: The rewritten boundary test still fails if the consumer is imported by `src/main.ts`, added to `PRODUCTION_JOBS`, or named by any infrastructure or workflow file (three mutations, all caught).
- **SC-005**: Every refusal (role, tenant, eligibility, changed replay, wrong state, not the requester) has a test, and each has a control that succeeds.

## Assumptions

- ASSUMPTION: the API process can load the knowledge set and recordings it needs to check the profile at start-up, as the worker does; both already load the knowledge set for the synchronous path. To be confirmed in slice 1.
- ASSUMPTION: a cancel can be serialized with a worker's claim by locking the job row, so a cancel and a claim never both succeed. To be proved with a concurrent test in slice 2.
- ASSUMPTION: the next free migration number at build time is 0053 (0052 is held by open PR 105). Re-read the directory when slice 2 starts.
