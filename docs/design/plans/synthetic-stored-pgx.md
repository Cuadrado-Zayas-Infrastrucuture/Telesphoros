# Stored synthetic PGx preview — slice 1 of the remaining OpenEMR work

Founder approved proceeding with “go” on 2026-10-11. Start from main `3210f21` after confirming #69 merged. Deliver one draft PR, then stop for review.

- Reuse existing authenticated GET routes for patient, evaluation, report, capture and caller roles. Add no backend route or SQL. The existing API enforces tenant scope and the synthetic pipeline gate.
- Add explicit local EHR-clinician → backend principal credentials and EHR-patient → stored UUID/label/evaluation bindings. Never forward an EHR bearer to the backend or return backend credentials to the browser. No automatic identity matching, token refresh or fallback to static fixtures when stored mode is selected.
- Read current stored state per request; verify scope/nonclinical flags, consent/interpretability, current accepted active evaluation, no dispute, report/capture/hash/patient agreement, and unchanged records on a closing read. Bound expiry to both sessions. Use only complete supplied gene states; no interpretation or recommendations.
- Reuse the FHIR builder for stored metadata. Existing public DTOs do not expose storage versions; represent a report/digest reference without invented bytes, storage version or retrieval URL. Version-pinned PDF retrieval remains slice 2.
- Preserve production routes/auth, retention, database schema, clinical engine/knowledge and gates. No production consent integration, deployment, spending, EHR writes or real data. Credentials stay in the ignored local runtime.
- Verify success/refusal controls, credential and patient containment, no outbound writes, late expiry/state changes, real synthetic PostgreSQL/API/ledger reads under restricted roles, and existing pilot regressions. Document any multi-request consistency limits. CI remains required before merge.
