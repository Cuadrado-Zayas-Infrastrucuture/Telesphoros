# Patient medications: capture-only backend, locally recovered
Date: 2026-11-01

Spec 029 MD-a has a local migration, append-only ledger integration, strict clinician-write/clinical-read API, replay and stale-correction controls, privacy and tenant-isolation tests, and shared FDA Tall Man presentation. No clinical interpretation, frontend, AWS or deployment change. The eligibility policy recognizes medication facts and keeps analytic release held.

The recovered source now contains 297 ingredients generated directly from CPIC and RxNav, with retained canonical-name evidence, release stamps and NLM attribution. The source-list blocker is resolved. The independent template-lifecycle repair and FHIR verification remain separate; publication, clinical use and MD-b are not authorized by this recovery. See [verification](../verification/patient-medications.md).
