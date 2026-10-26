# Readiness phase observer verification — 2026-10-26

PR 77's existing database-disappearance case intermittently exceeds Jest's five-second deadline. The prior fixture-only hypothesis was refuted by full-profile testing. The historical CI log does not identify the slow phase. This change adds observability only and does not claim a repair.

## Trace contract

Only this existing case creates the observer. Six sequential callbacks emit start and returned/threw records (twelve lines on normal completion) through native fd 2 via writeSync. This bypasses the buffered console path that yielded no useful markers in the prior full-profile diagnostic. Sequence preserves order. The allowlisted phase codes are fixture-create, app-start, healthy-ready, database-drop, failed-ready and health. Fields are diagnostic, sequence, phase, event and elapsedMs; elapsed time uses node:perf_hooks, is rounded and becomes null for an invalid/non-monotonic clock reading. No callback arguments/results/errors are serialized. An unsupported phase refuses before work or output. A sink failure is not silently ignored.

A start without an end identifies an unfinished phase at that observation point. A later returned event means only that callback returned; interpret it alongside Jest's timeout/failure and producer exit. The observer neither cancels work nor grants a longer deadline. Its small synchronous output can perturb timing, so a passing observed run cannot establish that the historical defect is gone.

## Preparation-time evidence

The first observer implementation passed callbacks through without recording. All four behavioral controls failed at assertions, not import/setup. The implemented observer passes all four: start visible before work, exact result/rejection preserved, pending callback remains visibly pending, and untrusted phase data rejected before work/output. Success and failure sentinels never appear in captured records.

All 27 focused observer, real-PostgreSQL readiness, dependency-timeout and health tests pass with no skips. The actual readiness case produced exactly twelve raw native-stderr records, sequence 1–12, all six phases in order, with only the fixed-schema fields. Full permitted output, native-sink parser receipt and producer exit are retained locally under /private/tmp/telesphoros-readiness-trace.

## Acceptance boundary

Readiness callbacks/assertions, fixture lifetime/cleanup, default Jest deadline, production probe deadline, CI routing and shared budgets remain unchanged. No production source imports this helper. Required local checks and real-service profile results must be assessed at the actual candidate; this preparation-time note does not claim later results or hosted acceptance. No publication, CI rerun, engine/model execution or clinical approval is authorized by this record.
