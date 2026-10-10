# Phase 2 evaluation-context batching

Final slice of the founder-approved three-slice sequence. Pagination PR #52 merged with all seven checks green; start from fresh main `8891dd8`. One independent PR.

The list already batches current evaluation IDs and reads complete dispute advisories once. It still reads the named acceptance, latest capture decision and correction history separately per evaluation. Add one tenant-scoped repository batch keyed by the selected evaluation IDs, reuse the canonical correction projections, and map the same DTO context. Keep detail/create reads and clinical write checks unchanged.

Scope excludes schema/migrations, clinical logic, UI, pagination contracts, knowledge/capture, AWS/identity-provider/production configuration, deployments, rulesets, live data and spending. Empty input does no work; unknown/foreign IDs are absent rather than fabricated. Corrections remain complete and ordered, including retraction/reinstatement/supersession chains. Named acceptance and its latest-decision comparison must remain capture-specific.

Verification: reproduce query-count growth on real PostgreSQL before the change; count executed SQL with pass-through instrumentation after the change, comparing one-, twenty- and maximum hundred-record pages. Check hand-written context expectations and unchanged detail/list parity for current/stale/null acceptances, correction chains and current flags. Check mixed/duplicate/missing/foreign IDs as the application role and as a superuser bypassing RLS. Inject defects, restore source hashes, rerun controls; lint/types/build and full PostgreSQL/S3/image/browser/security CI must pass.

Read transactions retain READ COMMITTED semantics; this does not freeze all context and page metadata into one snapshot. Batching limits query count, not the amount of a selected evaluation's complete correction history. Founder review/merge and whole-Phase-2 acceptance remain separate gates.
