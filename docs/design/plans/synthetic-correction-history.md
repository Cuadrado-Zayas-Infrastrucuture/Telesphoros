# Synthetic correction history and stale views

Approved 2026-10-11: build the next read-only OpenEMR slice from main `aa91225` and open one draft PR.

Reuse the authorized evaluation DTO's ordered correction history. Validate history identity/chain/state consistency; expose only correction IDs, kinds, reason codes and timestamps plus selected evaluation/state/current status. Omit notes and automatic replacement traversal. Retracted, superseded and non-current selections may return verified history but never genomic/PDF content; all existing eligibility gates still control genomic/PDF content. Verified history may also explain a held, disputed or outdated-acceptance selection.

Give stored evidence a maximum 30-second freshness period measured from request start. The viewer clears prior content before a 15-second recheck or explicit refresh, on hidden/offline state, request failure, freshness/session expiry or chart change. Abort/supersede pending reads so late responses cannot restore stale content. Reinstatement can display the explicitly selected result only after fresh reads and all existing gates pass; never select an older or replacement evaluation automatically.

No backend correction writes/routes, retention settings, clinical gates, production data, infrastructure, EHR writes or deployment changes. No founder decision is needed within this local scope. Polling is a bounded-staleness contract, not push invalidation or an atomic database snapshot; already saved synthetic PDFs cannot be revoked.

Verify real API retraction/reinstatement/supersession/newer-result sequences, identity/chain refusals, unchanged records during reads, UI polling/expiry/hidden/offline/late-response cleanup, source URL revocation, core FHIR output and existing pilot controls. Defect-inject a new guard, restore it, rerun checks and open a draft PR.
