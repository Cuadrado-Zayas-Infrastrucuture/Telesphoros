# Feature: the database issues a capability for the requester of a queued evaluation (spec 012 slice 1, local)

Date: 2026-10-28

Slice 1 of [spec 012](../../specs/012-worker-capability/spec.md). The founder approved the plan on 2026-10-28 with D1 to D5 as recommended. The guard (#141) already refuses queued evaluation and the evaluation worker while `ISSUER_URL` is set; this slice is the first step towards lifting it.

## What changed

Migration 0056 (`compat: breaking`):

- `tenant_capability_issue_for_job(job, worker, token_hash)`, owned by `telesphoros_capability` and executable only by the issuer login. It issues a capability with purpose `evaluation-job` (60 s) for the requester of an `evaluations.request` job, only when:
  - the named worker holds the job's lease;
  - the requester has an active membership with the clinician or reviewer role (plan D3);
  - the organization is active.
- It issues through `tenant_capability_issue`, so the membership version, the limits, the stored capability and the log row are handled as for every other capability. The job id is the capability's request id.
- Every answer is logged in `capability_issuance_log`. Two refusals are new, `job-not-held` and `role-not-allowed`, so the log's reason check is replaced with one that also allows them. Replacing a check counts as breaking under the migration lint; older code never writes either reason.
- The capability owner gains `SELECT` on `jobs` and `evaluation_requests`, with a read-only policy for that role on each, as 0028 did for `tenants` and `tenant_memberships`. No login holds that role.
- The down migration refuses while any job capability or its log row exists.

Nothing calls the function yet: the issuer serves it in slice 2, and the worker uses it in slice 3.

## How it was verified

See the [verification record](../verification/worker-capability-issue.md):

- The new PostgreSQL spec (16 tests) was seen failing first.
- A down-guard case, run as the restricted migrator.
- Mutations on each check.
- The full local loop.

## Not changed

- The issuer's code, the API, the worker, Terraform and CI.
- `tenant_binding_mode` stays `dual`.

Local only until the founder says push.
