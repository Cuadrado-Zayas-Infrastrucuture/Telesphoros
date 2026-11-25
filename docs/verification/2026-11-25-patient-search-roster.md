# Patient search on the server, the roster (spec 040, slice B), 2026-11-25

Branch `claude/040-slice-b-roster-search`, from `main` at `88a0fc4a`. All data is synthetic. P2: no code ran in the session that wrote
this; CI is the first run of every test named here, and its results are what count.

## What changed

- `apps/frontend/src/lib/api.ts`: `searchPatients`. The text is checked with `patientLabelSearchSchema` (the API's own rule) and refused
  without a request. Every answer but a 200 whose body passes the shared schema, with page size 20, is one failure: "The whole list could
  not be searched. Showing the loaded patients only." So an older API's 400 is never read as "no match".
- `apps/frontend/src/hooks/usePatientSearch.ts` (new): one search at a time. A new search, a changed text or leaving the page aborts the
  request in flight, and an answer that arrives after that is dropped (PS-12). "More matches" pages the same search.
- `apps/frontend/src/components/patients/PatientRoster.tsx` (PS-10, D4):
  - the field is now "Find a patient". Typing still filters the loaded rows at once and sends nothing;
  - while more pages remain, "Search all patients" sits beside it, and Enter does the same;
  - only a 200 replaces the rows with the matches and says "Searched all patients: N matches." (or "1 match.", or "no match.");
  - any other answer keeps the loaded rows, their filter and their sentence, and adds one line with Retry;
  - a text outside the alphabet is not sent, and the field says which characters it takes;
  - when every page is loaded there is no button: the loaded filter already covers everyone.
- The sentence under the field is reworded so it can sit beside the button: "Typing looks through the 20 patients loaded so far. Search
  all patients looks through every one." and, when all are loaded, "Typing looks through all 22 patients."
- `packages/help-content/src/help.en.json`: the draft article "Finding or adding a patient" names Search all patients. It stays a draft.

Not changed: the API and every backend file; `listPatients`; `useWorkspacePatients`; the two upload pickers (slice C); `PatientPicker`.

## Departures from the plan, and why

- **401 is not a fallback case.** The plan lists it with 400, 403, 429 and 500. In this app a 401 ends the session and starts a new sign-in
  (`AuthProvider`, `apiFetch`), so no list stays on screen to fall back to. The test list leaves it out and says so.
- **The field's label** changes from "Find loaded patients" to "Find a patient", because the field now reaches every patient through the
  button. The plan did not name the label.

## Tests

| Test | Where | Covers |
| --- | --- | --- |
| Typing filters and sends nothing; the button's 200 shows the matches, with the exact request | `PatientRoster.test.tsx` | PS-10, D4 |
| Enter searches; the text is trimmed; changing it returns to the loaded rows | `PatientRoster.test.tsx` | PS-10 |
| No match anywhere | `PatientRoster.test.tsx` | PS-10 |
| More matches pages the same search | `PatientRoster.test.tsx` | PS-3 through the client |
| 400, 403, 429, 500, a network failure, a malformed body, a wrong page size: loaded rows, filter and sentence kept, one line, Retry | `PatientRoster.test.tsx` | PS-10 |
| `%`, `_`, `'`, a space, 41 characters, empty: no request, the rule named | `PatientRoster.test.tsx` | PS-10, PS-1 |
| Every page loaded: no button, no request | `PatientRoster.test.tsx` | D4 |
| A newer search aborts the earlier one and drops its late answer | `PatientRoster.test.tsx` | PS-12 |
| The wording of the loaded-pages sentence | `PatientsPage.test.tsx` (updated) | specs/038 D17 |
| 25 patients made, the oldest found with the button; 25 matches and More matches; clearing returns; no sideways scroll; no WCAG A/AA violation; keyboard only | `e2e/patient-search.spec.ts` (new), at 375 and 1280 px | PS-10, against the real backend |

## Not done yet

- **Breakages** (plan, slice B), one at a time, each against its named test: the sentence claiming "all" on a non-200; the fallback
  removed; the text sent unchecked; the abort removed; the late-answer check removed. They join the open defect-injection list, which
  needs a place where tests run.
- **The founder's browser check**, from the steps below. Not yet done.

## The founder's browser check (written steps)

On a build with more than 20 synthetic patients, signed in as a clinician:

1. Open Patients. Under "Find a patient" the sentence says how many patients are loaded so far, and "Search all patients" is beside it.
2. Type the label of a patient who is not on the list (one of the oldest). The list says "No match among loaded patients." Nothing has
   been sent yet.
3. Choose Search all patients. The patient appears, and the sentence says "Searched all patients: 1 match."
4. Clear the field. The loaded list and its sentence come back, with More patients.
5. Type `SYN%` and press Enter. The field says "Use letters, numbers and hyphens only." and the list does not change.
6. With the API stopped (or the network off in the browser's tools), search again. The loaded list stays, one line says the whole list
   could not be searched, and Retry is offered. Nothing claims that all patients were searched.

Record here: the date, the build, and the result of each step.
