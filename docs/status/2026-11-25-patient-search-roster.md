# Patient search, slice B: the Patients list searches every patient (spec 040)

Date: 2026-11-25

Built from the plan the founder approved on 2026-11-13 (D1 to D5 as recommended). Slice A, the API's `labelContains`, merged in #390.

- **Typing still filters the loaded rows at once** and sends nothing.
- **While more pages remain, "Search all patients" (or Enter) asks the server** (D4). Only a 200 replaces the rows with the matches and
  says "Searched all patients: N matches."
- **Any other answer** (an older API's 400, 403, 429, 5xx, a network failure, a malformed body) keeps the loaded rows, their filter and
  their sentence, and adds one line saying the whole list could not be searched, with Retry (PS-10).
- **A text outside the label's alphabet is never sent**; the field says which characters it takes.
- **A newer search always wins:** the earlier request is aborted and a late answer dropped (PS-12).

The field is now "Find a patient". A 401 is not a fallback case: it ends the session. Records:
[verification](../verification/2026-11-25-patient-search-roster.md), [tasks](../../specs/040-patient-search/tasks.md).

Open: the slice's breakages (with the other open defect injections), the founder's browser check from the written steps, and slice C (the
two upload pickers). No backend, API, migration, Terraform or knowledge change.
