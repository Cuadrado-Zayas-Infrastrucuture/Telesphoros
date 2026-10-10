# Phase 3D1: retry-safe report registration

Founder approved the scoped plan with “ok” on 2026-10-10. Baseline `06fd007`; branch `feat/phase3d-report-registration`, isolated from the uncommitted workflow setup. Sequential work; no agents. One independent draft PR, then stop for review. Standard product upload remains a separate follow-on.

Objective: make a lost report-registration response safely retryable without creating another report. Existing unkeyed callers retain their current behavior. An optional UUID `requestId` in the creation body is canonicalized and scoped to authenticated tenant and creator. Compare a SHA-256 fingerprint of a fixed tuple of original patient ID, type, filename and size, rather than mutable report fields. Same key and original input return the current report with the same ID; conflicting input or a deleted report returns 409. The existing 201 response contract stays unchanged. Keys reserve their identity across soft deletion and are never exposed in report DTOs. This is metadata idempotency, not file-content deduplication, durable client retry state or a clinical acceptance.

| Task | Prerequisites | Deliverable / relevant files | Acceptance / verification | Status |
| --- | --- | --- | --- | --- |
| T1 | Approved scope, fresh main | Reproduce unkeyed lost-response duplication; inspect callers, SQL, constraints | Existing API produces two records for repeated unkeyed metadata; preserve as compatibility control | done |
| T2 | T1 and settled contract | Shared schema, report service/repositories, new migration 0014 up/down | Atomic PostgreSQL uniqueness, immutable identity/fingerprint, memory parity, no legacy rewrite | done |
| T3 | T2 | API and PostgreSQL controls, updated migration/catalog/recovery acceptance | Concurrent retries, conflicting inputs, tenant/creator separation, correction/deletion behavior, migration lifecycle and injected-defect refusals | done |
| T4 | T3 | Verification/status/docs and draft PR | Lint/types/build, complete backend tiers and inspected required CI; record failures/skips faithfully | in progress |

Do not touch product UI, auth policies, clinical algorithms/knowledge/pipeline holds, existing applied migrations, backup architecture, file recovery, provider/custody/scheduling, Terraform/AWS, deployments, production data or spend. Test-only migrations are applied exclusively in helper-owned ephemeral databases on the disposable synthetic PostgreSQL cluster.

Blast radius: tests create/drop only helper-generated `test_*` databases; migration rollback/injected defects affect those databases only. Fixtures can be regenerated from committed helpers. Down migration removes retry identity columns, constraint and guard, retaining report records; it must refuse populated retry identities unless an operator explicitly opts into losing that protection. No operational rollback or data remediation executes here. Preserve existing synthetic cluster files and retained logs.

Feedback: focused change → observed check → diagnosis → repair; reassess after three unsuccessful repairs, repeated identical failures without new evidence or no measurable progress. Classify implementation/environment/requirements/permissions blockers. Initial offline installation lacked a cached package; frozen installation with registry access succeeded without dependency changes. Verify before marking tasks done.

Evidence and repairs are recorded in [verification](../../verification/phase3d1-report-registration.md); next action is complete three-tier and final-head CI acceptance, then stop for founder review. Required live/cloud and product-upload acceptance stays open.
