# Implementation Plan: Asynchronous evaluation requests through the API and the local review page (H4)

**Branch**: `docs/spec-007-async-evaluation` | **Date**: 2026-10-27 | **Spec**: [spec.md](spec.md)

**Status**: Approved by the founder on 2026-10-27, with D1 to D5 as recommended: *"Approve spec 006 plan.md with D1-D5 as recommended. Write tasks.md, then start slice 1 on its own local branch."* Renumbered from 006 on 2026-10-28 at the founder's choice: open PR #109 already names the clinician-decision-records spec "spec 006"; quotations keep the founder's words as given.

**Amended 2026-10-28 (founder's choice):** slice 2 is cut off `main` without the cancel route, so it does not stack on the unmerged slice 1; the route `POST /evaluation-requests/:id/cancel` moves into slice 3 with the page's Cancel button.

## Summary

Three slices, each one PR off `main`. Slice 1 opens admission and status through two routes behind a new flag that is off by default and refused in production, and needs no migration. Slice 2 adds a requester cancel for a request that has not started, which needs one migration. Slice 3 adds the queued path to the local review page. The H3 worker, its binding, and everything that would deploy or schedule it are unchanged.

## Technical Context

- **Code touched**:
  - `apps/backend/src/config/env.ts`.
  - New files `apps/backend/src/lab-reports/evaluation-requests.controller.ts` and `evaluation-requests-switch.ts`.
  - `lab-reports.module.ts`.
  - `evaluation-requests.service.ts` (slice 2: `cancel`).
  - `storage/postgres/evaluation-requests.repository.ts` (slice 2: the `cancelled` state, `cancel`).
  - `packages/shared-types/src/evaluation-request.ts`.
  - One new migration pair (slice 2).
  - `test/evaluation-request-boundaries.spec.ts` (rewritten on purpose).
  - New e2e and pg specs.
  - `apps/frontend/src/pages/LocalReviewPage.tsx` and its test (slice 3).
  - Status notes, `docs/verification/`.
- **Not touched**:
  - `src/main.ts`'s consumer set.
  - `src/evaluation-worker.ts` and `evaluation-request-consumer.ts`.
  - `PRODUCTION_JOBS`.
  - `apps/worker`.
  - `infrastructure/`, `.github/workflows/`.
  - The synchronous evaluation route.
  - Clinical rules, holds, goldens.
  - `ModelPort`, any provider.
- **Runner**: the three backend tiers (in-memory, PostgreSQL, PostgreSQL + S3), Node 22.22.0, PostgreSQL 16, the frontend unit tests. The full local loop runs before each PR.
- **Fixture**: public D01 through the stand-in reader, as `test/evaluation-request-worker.e2e-spec.ts` does (`createTestApp({ labReportPipeline: true, … })`, `lab.reviewedCapture(fixturePdf('D01'))`).

## Constitution Check

| Principle | Result |
|---|---|
| I. Plan first, approved by the founder | Passes once this plan is approved; no code before it. |
| II. Synthetic data only | Passes: the flag is refused in production and needs the synthetic pipeline; fixtures are public D01; no PHI in a job, a log or a response (the job carries only `requestId`, as H1). |
| III. Inbound content is untrusted data | Not changed: the report text is read only by the existing reader, inside the worker. |
| IV. Tests earn their keep | Passes: every refusal has a succeeding control (SC-005); each guard is removed once to watch its test fail (SC-002, SC-004); the three tiers run. |
| V. Report outcomes faithfully | Each slice has a status note and a `docs/verification/` record saying what ran and what did not, including that the worker was never run as a deployed service. |

**Gate result**: passes. One standing boundary is changed on purpose (FR-008): H1's "absent from controllers" test is rewritten to "only behind the flag". D1 asks the founder to approve that.

## Design

### Slice 1: admission and status routes behind the flag (FR-001 to FR-003, FR-005, FR-006, FR-008)

- **The setting.** `EVALUATION_REQUESTS` in `env.ts`, default `disabled`. When it is `enabled`, the refinement requires:
  - `LAB_REPORT_PIPELINE=enabled`;
  - a parseable `EVALUATION_EXECUTION_PROFILE`;
  - `NODE_ENV` not `production`. This refusal goes in the same block as the pipeline's (`env.ts:209-220`).

  The worker keeps its own `EVALUATION_WORKER` switch, so the two processes are turned on separately.
- **The guard.** `EvaluationRequestsSwitch` mirrors `PipelineSwitch`, and `RequiresEvaluationRequests()` is applied after `RequiresPipeline()`. The order stays 401, 403, 503, then 400.
- **The profile.** When the flag is on, the module builds `EvaluationRequestsService` with the parsed profile. At start-up it calls the existing `assertRunsProfile` against `LAB_KNOWLEDGE` and `TextCaptureRunner.manifestSha256`, the same two values the worker checks (`src/evaluation-worker.ts:29`). When the flag is off, the controller is still registered so that it can answer 503, but the service gets no profile, and calling it throws.
- **The routes.**
  - `POST /reports/:id/evaluation-requests`:
    - Roles `clinician` and `reviewer`, rate class `expensive`, like the synchronous route.
    - The body `reportId` comes from the path.
    - It answers 202 when `created`, else 200.
  - `GET /evaluation-requests/:id`: clinical-read roles.
  - The global `SecurityAuditInterceptor` records both. No new audit code.
- **The boundary test.**
  - It now asserts that only `lab-reports.module.ts` and the new controller name the service, and that the module registers it only through the switch.
  - Every other assertion stays: `src/main.ts`, `PRODUCTION_JOBS`, `apps/worker`, `infrastructure/`, `.github/workflows/`.
  - Three mutations show it still fails (SC-004).
- **Tests.**
  - An e2e spec on PostgreSQL covering:
    - admit then status;
    - a replay;
    - a changed replay;
    - each role refused, with a control;
    - another tenant gets 404;
    - flag off gives 503 and the job count is unchanged.
  - D01 then completes with the H3 consumer run in the test process, and `GET /evaluations/:evaluationId` returns it (SC-001).
  - `env.spec.ts`: the default, both prerequisites, and the production refusal.

### Slice 2: cancel a request that has not started (FR-004)

- **The migration** takes the next free number at build time (0053 today).
- **The function** is `evaluation_request_cancel(request uuid)`, a narrow `SECURITY DEFINER` function owned by the queue's owner role, as `evaluation_job_fence` is in 0051. In one statement sequence it:
  - checks the active tenant;
  - checks that the caller is the request's requester and holds a write role now;
  - locks the job row `FOR UPDATE`;
  - refuses unless the job is `queued` or `retry`;
  - sets the job to `cancelled` with `finished_at`;
  - writes the cancellation record (D4).
- **Serializing with a claim.** A worker's claim takes the row `FOR UPDATE … SKIP LOCKED` (`0023_jobs.up.sql:188`). While a cancel holds the lock, the claim skips the job and then finds it cancelled; while a claim holds it, the cancel waits and then finds it `running` (409). Which one wins is decided by the lock, never by timing. A concurrent test runs both many times and checks that every run has exactly one winner.
- **Status.** The status read maps job `cancelled` to the new state `cancelled` instead of 503, and `EvaluationRequestDto['state']` gains it. The down migration refuses while any cancellation exists, run as the restricted migrator login, as 0050 and 0051 do.
- **The route** (moved to slice 3 on 2026-10-28). `POST /evaluation-requests/:id/cancel`, roles `clinician` and `reviewer`, returns the request.
- **Tests.**
  - Cancel then running the consumer stores nothing (SC-003).
  - Running, completed, dead or already-cancelled requests give 409.
  - A non-requester gets 403, with a control showing the requester succeeds.
  - Another tenant gets 404.
  - The concurrent cancel/claim test.
  - The down refusal.
  - Each guard in the function is removed once to watch its test fail.

### Slice 3: the local review page (FR-007)

- **The button.** "Queue synthetic evaluation" appears beside "Run synthetic evaluation". It posts with a fresh `requestId` kept in component state, so a double click replays rather than queueing twice.
- **The state.** It is shown as a word. "completion-missing" and "dead" read as operational states with a plain sentence, never as results.
- **Polling.**
  - `GET /evaluation-requests/:id` at 1 s, 2 s, 4 s, then every 10 s.
  - It stops at any state other than `queued`, `running` or `retry`, after 5 minutes, or when the page unmounts.
  - If it stops on time, the page says "No result yet; a worker may not be running" and infers nothing.
- **Cancel** is shown while the request can be cancelled.
- **The result.** On `completed`, the page fetches `GET /evaluations/:evaluationId` and shows it the way the synchronous result is shown today.
- **A 503** reads "Queued evaluation is turned off here".
- **Tests.** Component tests with a scripted fetch cover each state, the backoff stopping, unmount cleanup, cancel, and the 503 text. The page's existing development and `127.0.0.1` gate is unchanged.

## Founder decisions (only the founder can make these)

| # | Decision | Recommendation |
|---|---|---|
| D1 | Approve rewriting H1's boundary ("the service is absent from every controller") to "present only behind `EVALUATION_REQUESTS`, still absent from `main.ts`'s consumers, `PRODUCTION_JOBS`, the worker app and all deployments". | Yes. The guard keeps every deployment-facing promise; only the API door opens, behind a flag that production refuses. |
| D2 | Include cancel in H4 (slice 2, one migration) or defer it. | Include it, limited to requests that have not started. Without it, a mistaken click on a request that will never run can only be undone with the operator CLI. |
| D3 | Who may cancel: the requester only, or any clinician or reviewer in the organization. | The requester only. A colleague's queued work is theirs to withdraw. An operator still has `jobs cancel`. |
| D4 | Where the cancellation is recorded: a new append-only `evaluation_request_cancellations` table (who, when), or only the job's state plus a `job_attempts` row. | A new append-only table. It names the person, as H1's request does; `job_attempts` has no person column and is the queue's own record. |
| D5 | Order and size: three PRs (slices 1, 2, 3), or slices 1 and 3 first with cancel after. | Three PRs in order 1, 2, 3, so the page ships with its Cancel button. |

## Not touched by this plan or its PRs

- The H3 worker and its binding to the requesting person. Capability mode for a background worker is a separate decision, needed before any real data.
- Deployment of the worker, infrastructure, CI workflows, required checks and the ruleset.
- The synchronous evaluation route.
- Clinical rules, holds and goldens.
- Any model or provider.
- The clinical hold.

## Notes for whoever builds it

- The clinician-decision-records spec took 006 (open PR #109 names it), so this spec is 007.
- Re-read `apps/backend/migrations/` for the next number when slice 2 starts. On 2026-10-28 `main` ends at 0053, so slice 2 takes 0054; the clinician spec's D01b also plans one at 0054 or later, so whichever lands second renumbers.

## Complexity Tracking

| Addition | Why it is needed | Simpler alternative rejected because |
|---|---|---|
| A second switch, `EVALUATION_REQUESTS`, on top of `LAB_REPORT_PIPELINE` | Lets the synchronous pipeline run without opening the queued path, and keeps the API and worker switches separate. | Reusing the pipeline flag would open the queued path everywhere the synchronous one runs. |
| A cancellation table (if D4 is accepted) | A person-attributed, append-only record, matching H1. | Updating the request row is refused by its append-only trigger (0050). |
