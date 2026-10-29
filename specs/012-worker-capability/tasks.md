# Tasks: A background worker acts for the requester under an issuer capability

**Input**: [spec.md](spec.md), [plan.md](plan.md)

**Prerequisites**: plan.md **approved by the founder** on 2026-10-28 (D1 to D5 as recommended). The guard (#141) is merged.

**Tests**: Required (SC-001 to SC-005). In each phase the check is seen failing before the change that makes it pass, and each guard is removed once to watch its test fail.

**Organization**: One phase per slice, one PR per phase off `main`, never stacked, kept local until the founder says push. `[P]` marks tasks that can run in parallel within a phase. Hosted CI is capped at 3 runs per PR.

## Format: `[ID] [P?] [Story] Description`

## Phase 1: the database issues a job capability (slice 1)

- [ ] T001 Re-read `apps/backend/migrations/` for the next number, and check open PRs and other local branches for the same number
- [ ] T002 [US1] pg spec first (`test/db/worker-capability.pg-spec.ts`), as the issuer login: issued for the worker holding a running `evaluations.request` job, with the requester, the current membership version and the job id as request id; a log row for every answer
- [ ] T003 [US2] Refusals, each with its log row and no capability: a worker that does not hold the job (another worker, an expired lease, a job not running), a job of another type, a requester removed or suspended, a requester whose only role is `reader` (D3), a suspended organization; a reviewer control that succeeds
- [ ] T004 [US1] Only the issuer login may execute it: the application, worker, queue and migrator logins are refused (FR-002)
- [ ] T005 [US1] Migration: purpose `evaluation-job` (60 s) in `capability_purposes`; `tenant_capability_issue_for_job(p_job uuid, p_worker text, p_token_hash bytea)`, SECURITY DEFINER, owned by `telesphoros_capability`, EXECUTE to `telesphoros_issuer` only. It reads the job and its request without an organization binding (the issuer has none), so the capability owner gains read-only access to `jobs` and `evaluation_requests` through policies for that role alone, as 0028 did for `tenant_memberships`. It delegates to `tenant_capability_issue` so logging and storage stay in one place
- [ ] T006 Down migration: refuses while any `evaluation-job` capability or log row exists, run as the restricted migrator; a down-guard case
- [ ] T007 Catalogs: the reviewed schema inventory, the tenant-capability revert pattern, the policy count, and any function or grant catalog the new objects touch
- [ ] T008 Mutations: remove the lease check, the job-type check, the membership check, the role check and the organization check once each; grant EXECUTE to the application login once; each is caught (SC-003)
- [ ] T009 Full local loop; status note `docs/status/YYYY-MM-DD-worker-capability-issue.md`; verification record in `docs/verification/`

## Phase 2: the issuer serves an authenticated worker (slice 2)

- [ ] T020 [US1] Tests first: the request shape `{jobId, workerId, requestId}` with a signed request (D1): the signature covers the method, path, body digest and a timestamp, with a key per caller; a control that the signed worker succeeds
- [ ] T021 [US1] Refusals before any database call: no signature, a wrong key, a body that does not match its digest, a timestamp outside the allowed window, a replay within the window (SC-004); nothing echoes a key, signature or token (FR-007)
- [ ] T022 [US1] `IssuerCore.issueForJob` and the server route; the issuer's settings gain the worker key, required only when the route is enabled
- [ ] T023 Mutations on each signature check; full local loop; status note and verification record

## Phase 3: the worker runs under the capability (slice 3)

- [ ] T030 [US1] `runWithCapability(capability, work)` in `apps/backend/src/auth/authority-context.ts`; a boundary test that only the evaluation worker uses it
- [ ] T031 [US1] The consumer asks the issuer for a capability for each transaction (D2); refusals map to fatal codes (`requester-not-authorized`, `tenant-inactive`, `job-not-held`), an unreachable issuer to a retryable one (FR-005)
- [ ] T032 [US3] Worker settings `EVALUATION_WORKER_ISSUER_URL` and the worker key; the guard's worker refusal is lifted only when both are set; the API refusal is lifted only with `EVALUATION_REQUESTS_WORKER_BINDING=capability` (D4)
- [ ] T033 [US1] [US2] E2E on PostgreSQL with `TEST_REAL_ISSUER=1`: SC-001, SC-002, a requester removed while the read runs (nothing stored), and the guard still refusing without the issuer settings
- [ ] T034 Full local loop; status note; `docs/lab-report-reader.md` says what changes and what is still not proved (a deployed worker, the `capability` binding mode)
