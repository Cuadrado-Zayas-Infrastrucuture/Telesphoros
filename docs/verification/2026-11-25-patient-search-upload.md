# Patient search on the server, Attach a report (spec 040, slice C), 2026-11-25

Branch `claude/040-slice-c-upload-search`, from `main` after spec 052 RC1b (#481) merged. Synthetic data only. P2: no code ran in the
session that wrote this; CI is the first run of every test named here.

## What changed

- `components/patients/PatientSearchField.tsx` (new): "Find a patient", Search all patients (or Enter), the status line, the refusal of
  a text outside the label alphabet, the failure line with Retry, and More matches. It uses `usePatientSearch` from slice B through the
  page. It is not a form, because it sits inside the upload form: Enter searches and never submits the upload.
- `pages/UploadReportPage.tsx` (PS-11, D4):
  - the field sits above the patient choice while the patient list has more than one page;
  - only a 200 makes the choices the matches, and says "Searched all patients: N matches. The choices below are the matches.";
  - while the matches show, the page controls (Previous, Next, Refresh) are hidden; changing the text returns to the loaded page;
  - a chosen patient stays a choice through a search that does not match it (`selectedPatient`, unchanged `PatientPicker`);
  - any other answer keeps the loaded choices and says the whole list could not be searched, with Retry.

Not changed: `PatientPicker`, `usePatientPages`, the upload itself and its recovery, the Patients list (slice B).

## Departure from the plan

The plan put the search in two pickers, the chat's and the upload page's. Spec 052 removed the chat, so there is one. The plan's browser
search in `upload-navigation.spec.ts` is not added: that suite is about recovery after navigation, and `upload.spec.ts` carries the one
browser search for the one picker.

## Tests

| Test | Where | Covers |
| --- | --- | --- |
| Search all patients makes the choices the matches, says so, hides the page controls; the match can be chosen | `UploadReportPage.search.test.tsx` | PS-11 |
| The chosen patient stays a choice through a search that does not match it, and after the search is dropped | `UploadReportPage.search.test.tsx` | PS-11 |
| Enter in the field searches and never submits the upload | `UploadReportPage.search.test.tsx` | the field inside the form |
| A 500 keeps the loaded choices, says the whole list was not searched, Retry asks again | `UploadReportPage.search.test.tsx` | PS-10 |
| A refused text is never sent | `UploadReportPage.search.test.tsx` | PS-1, PS-10 |
| No search when every patient fits on one page | `UploadReportPage.search.test.tsx` | D4 |
| A newer search aborts the earlier one and drops its late answer | `UploadReportPage.search.test.tsx` | PS-12 |
| A patient beyond the loaded page is found and the upload goes to that patient | `e2e/upload.spec.ts`, at 375 and 1280 px | PS-11, against the real backend |

## Not done yet

- **Breakages** (tasks C4), with the open defect-injection list.
- **The founder's browser check**, from these steps, on a build with more than 20 synthetic patients, signed in as a clinician:
  1. Open Attach a report. "Find a patient" sits above the patient choice.
  2. Choose a patient from the first page. Then type the label of a patient who is not on it and press Enter. The choices become the
     match and the patient already chosen, and the line says "Searched all patients: 1 match."
  3. Choose the match. Clear the field: the first page comes back, with the match still chosen.
  4. With the network off in the browser's tools, search again: the loaded choices stay, one line says the whole list could not be
     searched, and Retry is offered.

  Record here: the date, the build, and the result of each step.
