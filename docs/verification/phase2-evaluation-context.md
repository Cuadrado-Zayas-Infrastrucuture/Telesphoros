# Phase 2 evaluation-context batching verification

Final approved Phase 2 slice, from fresh main `8891dd8` after pagination PR #52 merged with seven checks green. See [the plan](../design/plans/phase2-evaluation-context.md).

## Implemented

The public evaluation list loads context once for the selected page. The repository selects only requested tenant evaluation IDs, compares the named acceptance to the latest decision for its capture, and loads complete ordered correction history through the existing canonical projection loader. Missing selected context refuses the response. Current-evaluation IDs and complete dispute advisories keep their existing batched/once-per-list reads. Detail/create and clinical commit-time checks are unchanged.

## Executed evidence

- Before the change, pass-through instrumentation of real PostgreSQL/application-role queries observed **29 SQL statements for one record and 295 for twenty**. The constant-count assertion failed; this is a measured baseline, not a mocked pool.
- After the change, pages of **1, 20 and 100 records each executed 21 SQL statements**, including transaction and tenant-setting statements. All seeded evaluations have correction history, so this is not an empty-projection shortcut. Query count is tested, not wall-clock speed.
- **125 tests passed across six targeted real PostgreSQL/HTTP suites**: batching, current evaluation, pagination, evaluation, corrections and disputes. Context tests use hand-written state/current/acceptance expectations and compare list summaries to unchanged detail DTOs. They cover supersession/retraction/reinstatement chains, stale decisions, capture-specific current decisions, null acceptance, advisory retention, requested-only IDs, duplicate/missing IDs and foreign tenant IDs.
- The batch is checked as the application role and independently under a superuser bypassing RLS. Empty batch input executes zero statements.
- **Eight deliberate defects were rejected by assertions**, covering oldest/global acceptance decisions, reversed/truncated correction history, foreign selected evaluations, fabricated null acceptance, missing-context defaults and per-record query regression. Every source was restored byte-for-byte; all four restored context tests passed. See [defect evidence](phase2-evaluation-context-defects.json).
- Root lint/typecheck/build passed. Final-head CI supplies full backend tiers (including PostgreSQL/S3), browser, image, infrastructure and secret-scanning evidence; these are not claimed as local runs.

## Limits

Local HTTP tests used in-memory object storage. No AWS, live identity-provider, clinical or deployment tests ran. Reads retain READ COMMITTED semantics: the page, context statements, current IDs and dispute advisory are not one frozen snapshot. A selected evaluation's correction history and the complete internal dispute read remain complete; batching bounds statement count, not their history length. No UI, schema, clinical logic or API envelope changed in this slice. Whole-Phase-2 acceptance remains the founder's decision after review/merge.
