# The medication boundary check now catches a bare side-effect import

Date: 2026-11-19

The check that keeps medication capture out of clinical processing (MD-6,
`apps/backend/src/patient-medications/clinical-boundary.spec.ts`) read `from '…'`, `import(…)` and `require(…)`, but not
a bare `import '…'`. A side-effect import of the medication module into the engine, interpreter or verifier therefore
passed unnoticed. The check now matches all four forms, and a small test pins each form. No product behaviour, route, schema or stored data changes.
