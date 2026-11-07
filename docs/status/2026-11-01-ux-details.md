# Selected UX details for the existing app
Date: 2026-11-01

The [twenty-item UX evaluation](../design/ux-details-2026-11-01.md) selects six frontend improvements: a 300ms shared skeleton delay with the same Usage card/row layout while loading; local Undo for removing an unsent chat attachment; device safe-area spacing; tabular Usage and report-stage digits; balanced headings and short descriptions; and a pending/guarded chat send through patient creation with retryable creation failures. Existing UUID request identities and the supported JSON API contract remain unchanged. No dependency, backend, schema, infrastructure or clinical-content change.

Undo lasts eight seconds, pauses for pointer/focus interaction and is superseded by a new attachment. It never deletes a stored report. Safe-area behavior includes the app frame, sticky composer/navigation, skip link and modal drawers. Changes add no animation or motion library; shared skeleton and pending-button reduced-motion behavior is retained. The other details are already covered by existing controls or are excluded with reasons in the evaluation.
