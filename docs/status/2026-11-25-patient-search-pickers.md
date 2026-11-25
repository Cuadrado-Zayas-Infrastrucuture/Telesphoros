# Patient search, slice C: server search on the two upload pickers (spec 040)

Date: 2026-11-25

Built from the plan the founder approved on 2026-11-13 (D1 to D5 as recommended), completing slice C after slice A (#390) and slice B.

- **Reusable `PatientSearchField` above both pickers:** mounted above `PatientPicker` in `WorkspaceConversation` (chat upload drawer) and
  `UploadReportPage`, wired to `usePatientSearch` without touching `PatientPicker.tsx` or `PatientPicker.test.tsx`.
- **Safe inside forms:** renders no nested `<form>`; pressing Enter submits only the patient search and never submits the outer upload form
  or sends a chat message.
- **Selected patient survives search changes (PS-11):** while a 200 search holds, the picker lists the server matches and keeps any
  already-chosen patient selectable via `selectedPatient` — including when the search returns 0 matches, and after selecting a search-only
  patient and clearing the search.
- **Fallback, local refusal, and concurrency (PS-10, PS-12):** invalid text is refused locally with 0 requests; non-200/network/malformed
  responses keep the loaded choices and show Retry; a newer search aborts the earlier request and drops its late answer.
- **Tests:** unit tests for `PatientSearchField`, `WorkspaceConversation`, and `UploadReportPage`, plus one synthetic search case each in
  `e2e/upload.spec.ts` and `e2e/upload-navigation.spec.ts`. Record: [tasks](../../specs/040-patient-search/tasks.md).

Open: hosted Linux CI (`browser` tier included) and the founder's browser check. No backend, API, `PatientPicker`, migration, Terraform or
knowledge change.
