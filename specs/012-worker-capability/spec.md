# Feature Specification: A background worker acts for the requester under an issuer capability

**Feature Branch**: `docs/spec-012-worker-capability` (spec only; each implementation slice gets its own branch off `main`)

**Created**: 2026-10-28

**Status**: Approved 2026-10-28 ([plan.md](plan.md), D1 to D5 as recommended). Direction set by the founder on 2026-10-28: option B, _"the issuer checks again when the worker picks up the job"_, with a fail-closed guard first (#141, merged as `fefcb31`).

**Input**: H4 ([spec 007](../007-async-evaluation/spec.md)) left out "how a background worker acts". The [P2 session authority decision](../../docs/design/plans/agentic-session-capability.md) of 2026-10-19 accepted a trusted backend identity for synthetic-only staging and requires an issuer-proved identity before any real data.

Line numbers cite `main` `c0de882`.

## The problem

- **The API proves who is asking; the worker does not.** With `ISSUER_URL` set, every API request is issued a capability by the session issuer, after it verifies the person's Cognito token (`apps/backend/src/issuer/issuer-core.ts:57-77`). The database then takes the organization and the person from that capability, not from a setting (`apps/backend/migrations/0028_tenant_capability.up.sql:198-222`).
- **The evaluation worker has no token, so it is issued nothing.** It sets the organization and names the requester itself (`apps/backend/src/lab-reports/evaluation-request-consumer.ts:41`, `apps/backend/src/db/database.ts:101-103`). In the `dual` binding mode, which `main` is in (`0032_tenant_binding_policies.up.sql:534`), the database accepts those settings.
- **The database re-checks the requester, but trusts the worker's word for who that is.** When a result is stored, `evaluation_completion_check` requires the person acting to be the requester and still an active clinician or reviewer (`0051_evaluation_request_completion.up.sql:36-48`, `0050_evaluation_requests.up.sql:51-62`). The person acting is whoever the worker named.
- **The issuer cannot serve a second kind of caller.** It accepts only `{accessToken, requestId}` (`apps/backend/src/issuer/issuer-server.ts:34-37`) and has no caller authentication of its own: it relies on the network (`docs/design/plans/tenant-capability-issuer-transport.md:123-130`).
- **The `capability` mode would break the worker.** Without a capability, the organization and person resolve to nothing in that mode (`0047_active_tenant_binding.up.sql:30-34`). Row-level security then returns no rows rather than an error, so the worker would mark the request dead for the wrong reason.

Until this spec is built, the guard refuses `EVALUATION_REQUESTS=enabled` and the evaluation worker while `ISSUER_URL` is set.

**Rule:** a queued evaluation is answered only under a capability the issuer issued, for the person who asked, after it checked that person's current membership and role. The worker's own word is never enough.

## Out of scope (v1)

- Moving `tenant_binding_mode` to `capability`. That also needs the agentic worker side fixed (`0030_agentic_synthetic_identity.up.sql:11-12`) and is its own change.
- Running the worker as a deployed service, `PRODUCTION_JOBS`, Terraform, CI workflows. The worker still runs only by hand, locally.
- The issuer's verification of user tokens, and the API's own capability path (`auth.guard.ts`, `request-capabilities.ts`).
- `tenant_capability_bind_internal` (`0032:328-352`), the database's own capability for ledger, jobs and redaction work. It names no person and stays as it is.
- Any other job type. Only `evaluation-request` jobs gain a person-bound capability.
- Real data. The pipeline and the queued path stay synthetic and refused in production.

## User Scenarios & Testing

### User Story 1: a queued evaluation runs as the person who asked, proved by the issuer (Priority: P1)

A clinician queues an evaluation. A worker claims the job and asks the issuer for a capability for that job. The issuer finds the requester from the job, checks they are still an active clinician or reviewer in an active organization, and issues a capability for them. The worker stores the result under it.

**Independent test**: with the issuer running (`TEST_REAL_ISSUER=1`) and the worker configured for it, queue a request for public fixture D01, run one job, and read `completed`. The completion row's transaction carried a capability whose person is the requester (asserted through the issuance log).

**Acceptance scenarios**:

1. **Given** a queued request and a worker holding its job, **when** the worker asks for a capability, **then** the issuer issues one for the requester, and the result is stored.
2. **Given** a worker that does not hold the job (no lease, or another worker's), **when** it asks, **then** the issuer refuses, logs the refusal, and issues nothing.
3. **Given** a caller that is not an authenticated worker, **when** it asks for a job capability, **then** the issuer refuses before reading anything.

### User Story 2: a requester who lost access is refused by the issuer (Priority: P1)

The requester is removed, suspended, or loses the clinician and reviewer roles after queuing. The issuer refuses the job's capability, the refusal is logged, and the request ends with a reason that says so.

**Acceptance scenarios**:

1. **Given** a requester removed after queuing, **when** the worker asks, **then** the issuer refuses with `membership-not-current`, and the request reads `dead` with `requester-not-authorized`.
2. **Given** a requester whose only remaining role is `reader`, **then** the issuer refuses with a role reason (plan D3).
3. **Given** a suspended organization, **then** the issuer refuses with `tenant-inactive`.
4. **Given** a requester removed while the read runs, **then** the result is not stored (the membership version the capability carries is no longer current at commit).

### User Story 3: nothing changes where the issuer is not in use (Priority: P1)

With `ISSUER_URL` unset, the worker behaves as on `main` today, and the guard's refusals are lifted only for a worker configured for the issuer.

## Requirements

- **FR-001**: The issuer accepts a job-capability request only from an authenticated worker caller (plan D1), separately from the user-token request.
- **FR-002**: A database function owned by the capability owner, executable only by the issuer login, issues a job capability: it reads the job and its evaluation request, requires the named worker to hold the job's lease, and checks the requester's active membership, the clinician or reviewer role, and an active organization. It writes one issuance-log row for every answer, issued or refused.
- **FR-003**: A job capability has its own purpose (for example `evaluation-job`), lasts at most 60 s (`0028:56`), names the requester and the membership version current at issuance, and carries the job id as its request id.
- **FR-004**: The worker runs each transaction of a job under a capability, obtaining a new one when the last has expired or is about to (plan D2). It never stores a result without one when it is configured for the issuer.
- **FR-005**: A refusal maps to a fatal job error with a code (`requester-not-authorized`, `tenant-inactive`, `job-not-held`), never a message; an issuer that cannot be reached is retryable.
- **FR-006**: The guard's refusals stay for a worker without issuer configuration; a worker configured for the issuer starts beside an API that uses one, and `EVALUATION_REQUESTS=enabled` is allowed beside `ISSUER_URL` only when the configuration says a worker will act under capabilities (plan D4).
- **FR-007**: No secret, token, capability value or address appears in a log line, error, job error or test output.

## Success Criteria

- **SC-001**: D01 completes through a worker under an issuer capability, on the real issuer in the test process.
- **SC-002**: Each refusal in User Story 2 is seen, with its issuance-log row, and nothing is stored.
- **SC-003**: Removing each check from the database function once (lease, membership, role, organization) makes a test fail.
- **SC-004**: An unauthenticated or wrongly authenticated caller is refused, with a control that the authenticated worker succeeds in the same run.
- **SC-005**: With `ISSUER_URL` unset, the full local loop is unchanged.
