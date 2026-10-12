# Synthetic correction history and stale views

This extends the [stored reader](stored-pgx-preview.md) and optional [source PDF](source-pdf-preview.md). No new configuration or write permission is needed. Rebuild/restart the local pilot so its viewer and evidence response use the same freshness contract.

## History and evidence are separate

The existing tenant-authorized evaluation read includes all corrections, oldest first. The adapter validates same-evaluation event identity, unique IDs, predecessor chain, permitted kind/reason combinations and agreement with reported state/replacement/current status. History is refused rather than truncated above 500 events; the existing response-size bound still applies.

Only the selected evaluation ID, state/current flag, event IDs/kinds/reason codes/timestamps and a deterministic revision are displayed. This revision identifies the display snapshot; it is not ledger verification. No note text/digests, reviewer identities, replacement IDs or recommendation text are exported. No note endpoint is called. Eligible FHIR previews carry the revision as a local DiagnosticReport extension.

All existing consent, patient/principal/tenant, synthetic-scope, source-integrity and content eligibility checks remain. The identity/source/closing-read checks run before any history is returned. Content requires current active evaluated evidence, no hold/dispute, a current accepted matching capture decision and complete canonical genes. A verified state/hold/dispute/acceptance verdict that withholds content returns a history-only response with `evaluation_withheld`, `pgxFhirPreview: null` and an empty profile. It does not fetch PDF bytes. Malformed or incomplete eligible gene data and failures to verify the context/history/source return the sanitized unavailable response, without history or evidence.

A retracted or superseded selection shows its history, not an older or replacement result. A non-current active selection is also withheld. An independently recorded reinstatement can restore the explicitly selected evaluation only when a fresh read passes every content gate. Selecting a different evaluation remains an explicit registration change and new chart launch; this viewer cannot create a correction or choose a replacement automatically.

## Freshness contract

Each evidence response includes `freshUntil`: at most 30 seconds after the server started reading EHR context and no later than its existing SMART/backend/source-link expiry. If reads already consumed that interval, the server refuses the response.

The viewer normally rechecks every 15 seconds after a successful response. Before rechecking, it clears prior context, genomic content, history and the local PDF download link. A Recheck evidence button performs the same GET-only path; it is disabled while checking. There are no simultaneous active viewer requests. Each successful read revalidates EHR identity/consent/medications and backend identity/state/source; no cached eligibility verdict is reused.

Freshness/session expiration, hidden/offline state, request errors or timeout remove content and revoke blob URLs. Visible/online/focus events and explicit rechecks request fresh evidence. Failures do not retain old data or automatically retry in a loop. Pending requests are aborted on invalidation/unmount, and generation checks reject late results even if transport ignores abort. A new chart session remounts the view. The existing session/source expiry remains an upper bound; no credential refresh or automatic extension beyond that observed lifetime is introduced.

This bounds displayed staleness under normal browser event-loop operation; it is not instantaneous push invalidation or a database snapshot. Browser suspension/timer delays cannot be a real-time guarantee. Resume events clear/recheck. Previously saved synthetic PDFs cannot be revoked. Multiple open tabs consume additional existing API rate-limit capacity; a refusal clears evidence, and no rate limits are relaxed.

## Local verification

Run the normal pilot tests and the existing backend stored-PGx integration spec with PostgreSQL/S3 services. Tests create synthetic correction records through existing authorized write APIs only as setup; the connector itself uses GETs and verifies unchanged evaluation/ledger counts while reading. The browser check uses synthetic response fixtures alongside separate actual-backend transition tests; full end-to-end workflow acceptance remains a later slice.

See [verification](../verification/synthetic-correction-history.md). Retention settings, clinical gates, backend routes/schema, EHR writes, production data and deployment remain unchanged.
