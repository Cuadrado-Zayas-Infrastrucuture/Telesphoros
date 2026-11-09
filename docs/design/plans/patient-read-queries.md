# Local database read performance slice

Continue the user-approved performance plan after the completed frontend phase.
Start from main 3c22c756 on a separate local branch. Measure real patient-read
repositories with the existing disposable PostgreSQL 16 application-role harness,
ordinary and longer synthetic histories, matched first-read/warm samples and
EXPLAIN ANALYZE/BUFFERS. Profile medication latest-version reads and demographics
history payloads; retain only a measured minimal read-query improvement.

Preserve API DTOs, ordering, historical versions, current flags, tenant parameters,
RLS, live authorization, transactional consistency, ledger/audit guarantees and
clinical freshness. No schema/index/migration, cache, dependency, CI, clinical,
cloud or deployment change. No push or PR. Confirm the frontend branch remote
without pushing it.

Verify independent result oracles, tenant/patient isolation, history and latest
reads after a committed correction, concurrent reads/writes, refusals and audit
integrity. Use red/green and guard controls where behavior changes, the affected
real-service suites, all required repository checks and all three backend
profiles. Record skips and unavailable private-engine coverage. Document results
and preserve raw evidence; the Mac vault is not mounted here.

The measured retained candidate aggregates only entry IDs and maximum versions before joining the selected current records. Historical reads stay on the existing query. Full-row DISTINCT ON variants were rejected because they did not consistently improve the longer-history case. Demographics payload changes are deferred.
