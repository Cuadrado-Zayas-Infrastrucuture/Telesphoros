# Patient search, slice C: the field's own unit tests, kept from a second build (spec 040)

Date: 2026-11-25

Slice C was built twice in parallel. #482 merged first (`docs/status/2026-11-25-patient-search-upload.md`), and spec 052 removed the chat,
whose upload drawer this PR (#483) also changed. The founder chose to keep main's slice C and keep only what this PR adds that main lacks.

- **Kept:** `components/patients/PatientSearchField.test.tsx`, adapted to the field that merged: Enter inside an outer form searches and
  never submits it; changing the text drops the search; the refused, found (with More matches and its failure) and failed (with Retry)
  states, each with an axe check.
- **Not kept:** this PR's own field, its upload page wiring and its upload test, which duplicate #482; the chat drawer's search, its
  unit tests and its browser case in `e2e/upload-navigation.spec.ts`, since the chat is gone (spec 052 RC1b).

No product code change. No backend, API, migration, Terraform or knowledge change.
