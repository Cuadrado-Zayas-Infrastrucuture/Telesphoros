# Browser tests: why the in-memory e2e API answers demographics with 503

Date: 2026-11-23

PR #450 found that a patient page in the `browser` job shows only "The demographics could not be loaded. Please retry.", so
`e2e/genomic-profile.spec.ts` answers `GET /patients/:id/demographics` itself. The reason, recorded here and in that test:

- The job's API runs with `STORAGE_DRIVER=memory` (`playwright.config.ts`), because it sets no `E2E_DATABASE_URL`.
- The in-memory store has no demographics on purpose. They are ledgered records (spec 025 D5), and the ledger exists only on PostgreSQL. So
  `UnavailablePatientDemographicsRepository` answers 503 before the read could reach the 404 `no-demographics`. Medications, follow-ups and
  structured records do the same.
- No setting in the `webServer` env changes this. Serving the route needs PostgreSQL and `PATIENT_FIELD_LOCAL_KEY`: the nightly, advisory
  `e2e-storage` suite, where `storage-e2e/patient-demographics.spec.ts` tests it.

The founder chose to keep the stand-in and document the reason (option A). These were not chosen:

- Running the required `browser` job on PostgreSQL. It would change a required check.
- Letting the patient page render without its demographics. It would show guidance without the identity banner, a patient-safety decision.
- An in-memory demographics store. It would go against D5.

`docs/ops/ci-cd.md` says it in the `browser` row. Test comment and documentation only: no code, route, setting, check or workflow change.
