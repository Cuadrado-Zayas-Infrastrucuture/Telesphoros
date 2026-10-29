# Feature: queue a synthetic evaluation from the local review page, follow it, and cancel it (H4 slice 3, local)

Date: 2026-10-28

Slice 3 of [spec 007](../../specs/007-async-evaluation/spec.md) (H4). Slice 1 (#119) opened queueing and status, and slice 2 (#120) let the requester cancel. On 2026-10-28 the founder moved the cancel route into this slice, so slice 2 did not stack on slice 1.

## What changed

The route:
- `POST /evaluation-requests/:id/cancel`, for roles `clinician` and `reviewer`, behind the pipeline's switch and `EVALUATION_REQUESTS`.
- It takes no body and returns the request.
- It answers:
  - 200 `cancelled`;
  - 409 `not-cancellable` once a worker has started the request;
  - 403 for anyone but the requester;
  - 404 for another organization;
  - 503 `EVALUATION_REQUESTS_DISABLED` while the switch is off.

The local review page gains "Queue synthetic evaluation" for an accepted capture:
- It keeps one `requestId` per accepted decision, so asking again replays the request instead of queueing a second one.
- It shows the state as words, for example "Queued evaluation: waiting to retry." `dead` and `completion-missing` say plainly that there is no result.
- It checks again after 1, 2 and 4 seconds, then every 10 seconds. It stops at any state other than queued, running or retry, after five minutes ("No result yet; a worker may not be running. Nothing is inferred."), or when the page goes away.
- It offers "Cancel queued evaluation" only while the request is queued or waiting to retry.
- On `completed` it fetches the stored evaluation and shows it as the synchronous path does.
- A 503 `EVALUATION_REQUESTS_DISABLED` reads "Queued evaluation is turned off here."

The result area's accessible name was "Stored report text", the same as the stored-text panel. It is now "Evaluation result"; nothing else used that name. `docs/lab-report-reader.md` describes the three routes and what they do not prove (FR-009).

## How it was verified

See the [verification record](../verification/evaluation-request-review-page.md):
- Route cases on PostgreSQL, the gate inventory, and component tests on fake timers for each state, the backoff, the five-minute stop, leaving the page, the replay, cancel and the 503 text.
- Nine mutations, each caught.

## Not changed

- The worker and how it acts for the requesting person.
- `PRODUCTION_JOBS`, the worker app, infrastructure and CI workflows.
- The synchronous route and the "Run synthetic evaluation" button.
- Clinical rules, holds, goldens, and any model or provider.
- The page is still development-only on `127.0.0.1`.

Local only until the founder says push.
