# Tasks: Easier daily use for clinicians

Slice A only. Front end and the shared ranking; no API, schema, setting or infrastructure change. The plan is the decisions in [spec.md](spec.md).

- [ ] T001 Ranking (D1): `rankDrugs` in `packages/shared-types/src/drug-list.ts` breaks ties by brand presence; unit test on fixtures, and a test on the bundled list that fails under the old order ("li" offers lisinopril, "am" amlodipine, "me" meloxicam, "se" sertraline).
- [ ] T002 Age (D2): `DemographicsValues` uses `exactAge`; test that the table and the banner agree near a birthday.
- [ ] T003 Date of birth (D3): `birthDate()` in `lib/formatWhen.ts`, used by `PatientBanner` and `DemographicsValues`; tests, including a date that a time-zone shift would move.
- [ ] T004 Results (D4): processing-off reads as a status with no retry in `ResultsList`; unit test; `product-demo-e2e/patient-results-unavailable.spec.ts` updated. The temporary-failure path keeps its retry (`decision-e2e/patient-decisions.spec.ts`, unchanged).
- [ ] T005 Chat home (D5): `ConversationWelcome` row layout; walked at 390 px.
- [ ] T006 Checks in the sealed sandbox: shared-types and front-end typecheck, lint, format and tests; build and chunk check.
- [ ] T007 Before/after screenshots in the staging-style build at 1280 and 390 px.
