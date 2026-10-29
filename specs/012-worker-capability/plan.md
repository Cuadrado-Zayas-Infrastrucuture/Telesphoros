# Implementation Plan: A background worker acts for the requester under an issuer capability

**Spec**: [spec.md](spec.md)

**Status**: Draft. Nothing below is built until the founder approves this plan and decides D1 to D5.

Line numbers cite `main` `c0de882`.

## Summary

Three slices, each one PR off `main`, kept local until the founder says push:

1. The database issues a job capability for the requester of a job the calling worker holds, after checking membership, role and organization.
2. The issuer serves that request to an authenticated worker caller.
3. The worker runs each job's transactions under such a capability, and the guard's refusals are lifted for a worker configured this way.

## Technical Context

- **Issuance today.** `IssuerCore.issue` verifies a Cognito token, makes 32 random bytes and sends the database only their SHA-256 (`apps/backend/src/issuer/issuer-core.ts:57-77`). The database function is `tenant_capability_issue_current` (`0031:18-45`), owned by `telesphoros_capability` and executable only by `telesphoros_issuer`. It delegates to `tenant_capability_issue` (`0028:117-167`), which checks the purpose, an active organization and the current active membership version, logs every answer (`:153-155`) and stores the capability (`:161-162`). It does not check roles.
- **Capabilities.** At most 60 s (`0028:56`). Not single-use: valid until expiry or revocation. Bound to organization, person, membership version, purpose and a request id.
- **Consumption.** `app_tenant_bound()` and `app_actor()` look the capability up once per statement (`0047:23-46`, `0028:198-222`). With a capability present, the actor setting is ignored.
- **The worker today.** `evaluation-worker.ts` opens no authority context. `Database.withTenant` takes a capability only from the request context (`apps/backend/src/db/database.ts:81-136`), and `bindRequestCapability` needs a context and is write-once (`apps/backend/src/auth/authority-context.ts:67-75`).
- **The issuer's callers.** One request shape, `{accessToken, requestId}` (`issuer-server.ts:34-37`). No caller authentication beyond the network (`docs/design/plans/tenant-capability-issuer-transport.md:123-130`), which names signed requests or mutual TLS as the next step for a caller outside the API (`:130`).
- **The guard.** `fix/evaluation-requests-issuer-guard` (local) refuses `EVALUATION_REQUESTS=enabled` and the evaluation worker while `ISSUER_URL` is set.

## Constitution Check

- Plan first, approved by the founder: this document.
- Synthetic data only: the queued path stays refused in production and runs only on public fixtures.
- Secrets: a caller key (D1) lives in an environment variable or a secrets manager, never in code, logs or test output. Tests generate their own.
- Tests first, a mutation for each check, the full local loop before any PR.

## Design

### Slice 1: the database issues a job capability (FR-002, FR-003)

- Re-read `apps/backend/migrations/` for the next number. `main` ends at 0054, and the clinician spec's D01b branch also planned 0054, so one of them renumbers.
- New purpose `evaluation-job` in `capability_purposes`, lifetime 60 s.
- New function `tenant_capability_issue_for_job(p_job uuid, p_worker text, p_token_hash bytea)`, SECURITY DEFINER, owned by `telesphoros_capability`, EXECUTE to `telesphoros_issuer` only. It:
  - reads the job and its evaluation request (organization, requester);
  - requires `p_worker` to hold the job's lease, as `evaluation_job_fence` does;
  - requires the requester to have an active membership with the clinician or reviewer role (D3), and the organization to be active;
  - delegates to `tenant_capability_issue` with the current membership version, so the logging and storage stay in one place;
  - returns `(expires_at, refusal, membership_version)` like `tenant_capability_issue_current`.
- A down migration that refuses while any `evaluation-job` capability or log row exists, run as the restricted migrator.
- PostgreSQL specs first: issued for the holder; refused for a non-holder, a removed requester, a reader-only requester and a suspended organization, each with its log row; the app and worker logins cannot execute the function.

### Slice 2: the issuer serves an authenticated worker caller (FR-001, FR-007)

- A second route or request shape, `{jobId, workerId, requestId}`, accepted only with the caller authentication chosen in D1.
- `IssuerCore.issueForJob` generates the token, sends its hash to the slice 1 function, and returns it with the expiry.
- The issuer refuses before any database call when the caller check fails, and logs a refusal code.
- Tests: the authenticated worker succeeds (control); no key, a wrong key, a replayed or expired signature (if D1 = signed requests) each refused; nothing echoes a key or token.

### Slice 3: the worker runs under the capability (FR-004 to FR-006)

- An exported authority runner, `runWithCapability(capability, work)`, opens a context the way the request middleware does. Only the evaluation worker uses it; a boundary test enforces that.
- The consumer asks the issuer for a capability for each transaction (D2), and maps refusals to fatal codes and an unreachable issuer to a retryable one.
- Worker settings: `EVALUATION_WORKER_ISSUER_URL` and the caller key (D1). The guard's worker refusal is lifted only when both are set; the API's refusal is lifted only by the setting chosen in D4.
- E2E on PostgreSQL with `TEST_REAL_ISSUER=1`: SC-001 and SC-002, a requester removed mid-read, and the guard still refusing without issuer settings.
- Status note, verification record, and `docs/lab-report-reader.md`.

## Founder decisions (only the founder can make these)

| #   | Decision                                                                                                                                                                                                                         | Recommendation                                                                                                                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | How the issuer authenticates the worker: (a) a signed request with a key per caller, held in a secrets manager; (b) mutual TLS through Service Connect; (c) the network only, as for the API.                                    | (a). Worker ids are not secrets, so (c) lets anything on the network name a worker. (a) works locally and in tests without certificates; (b) can follow when the worker is deployed.               |
| D2  | Capability lifetime for a job: (a) a new capability per transaction; (b) one per job, renewed when less than 15 s remain.                                                                                                        | (a). A job has a few transactions (read the request, store the result), so the cost is a few issuer calls. It has no renewal race, and each transaction is checked against the current membership. |
| D3  | Where the role is checked: (a) in the new database function as well as at completion; (b) only at completion, as today.                                                                                                          | (a). The refusal is then logged by the issuer, as the founder chose for admission refusals on 2026-10-20 (DATA-01 slice 3, decision (i)), and the worker never gets a capability it cannot use.    |
| D4  | How the API knows a capable worker exists before it accepts queued requests beside `ISSUER_URL`: (a) a setting `EVALUATION_REQUESTS_WORKER_BINDING=capability` that must be set; (b) keep refusing until the worker is deployed. | (a). It keeps the refusal as the default, and the person who enables it states what they rely on.                                                                                                  |
| D5  | Order and size: three PRs in order 1, 2, 3; or slices 1 and 2 together.                                                                                                                                                          | Three PRs in order. Slice 1 is a migration and needs its own review.                                                                                                                               |

## Not touched by this plan or its PRs

- `tenant_binding_mode` (stays `dual`), the agentic worker side (0029, 0030), and `tenant_capability_bind_internal`.
- The API's capability path, the issuer's token verification, Terraform, CI workflows, required checks and the ruleset.
- Deployment of the worker or the issuer.
- Clinical rules, holds, goldens, any model or provider.

## Notes for whoever builds it

- Recheck the spec and migration numbers against `main`, open PRs and other local branches right before each push.
- The guard branch must merge before slice 3, which lifts part of it.
- Several code comments still say the binding mode is `guc` (`apps/backend/src/issuer/request-capabilities.ts:22`, `apps/backend/src/db/database.ts:46-47`); `main` is in `dual` (`0032:534`). Not fixed here.

## Complexity Tracking

| Addition                         | Why it is needed                                              | Simpler alternative rejected because                                                         |
| -------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| A second issuer request type     | The worker has no user token to present.                      | Storing a capability at queue time breaks the 60 s limit and checks the requester only once. |
| A caller key (if D1 = a)         | Something must prove the caller is the worker.                | The network alone cannot tell the worker from any other task in the same group.              |
| An authority runner outside HTTP | The database layer takes capabilities only from that context. | Passing a token through every repository call would change dozens of signatures.             |
