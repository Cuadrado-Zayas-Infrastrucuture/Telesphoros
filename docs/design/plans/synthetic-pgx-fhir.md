# Synthetic versioned PGx to FHIR

Authorized by the founder's “just do it” on 2026-10-11. Branch `feat/synthetic-pgx-fhir-mapping` starts at main `935aebb` after confirming #66–68 merged.

- Extend only the isolated SMART pilot with explicit, patient-bound versioned evaluation fixtures and a core FHIR R4 collection preview in the authenticated evidence response.
- Map DiagnosticReport, genotype/phenotype Observations, source DocumentReference and Provenance. Preserve evaluation identity, engine/knowledge versions, source version and SHA-256. Never infer a diplotype from a phenotype or use the SMART encounter as the historical test encounter.
- Require consent, interpretable/context gates, current accepted active evaluation, no dispute, exact patient/tenant binding and verified synthetic source digest. Refuse missing/ambiguous/stale versions without falling back to an older result.
- Show a collapsible read-only preview; versioned fixtures are generated only by explicit local provisioning. Existing registrations without them remain unavailable.
- Leave production routes, database/storage, retention, clinical engine/knowledge, clinical gates and EHR write scopes alone. No deployment, recommendations or real data.
- Verify mapping and refusal/control tests, HTTP session/identity behavior, output reference closure, pinned R4 structural checks, lint/types/build, real synthetic OpenEMR launches, and CI. Document validation limits; do not claim IG profile or clinical conformance.
- Open a new draft PR from main. No unresolved founder decision is needed within this synthetic scope; clinical deployment is outside it.
