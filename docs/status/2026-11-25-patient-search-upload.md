# Patient search, slice C: Attach a report searches every patient (spec 040)

Date: 2026-11-25

Built from the plan the founder approved on 2026-11-13 (D1 to D5 as recommended), after slice B (#474). Spec 052 removed the chat, so the
search goes into the one picker left, on Attach a report.

- **"Find a patient" sits above the patient choice** while the list has more than one page (D4). Search all patients, or Enter, asks
  the server; Enter never submits the upload.
- **Only a 200 makes the choices the matches** and says so. A chosen patient stays a choice through a search that does not match it (PS-11).
- **Any other answer keeps the loaded choices** and says the whole list could not be searched, with Retry (PS-10). A newer search
  always wins (PS-12).

Records: [verification](../verification/2026-11-25-patient-search-upload.md), [tasks](../../specs/040-patient-search/tasks.md). Open: the
breakages and the founder's browser check. No backend, API, migration or Terraform change.
