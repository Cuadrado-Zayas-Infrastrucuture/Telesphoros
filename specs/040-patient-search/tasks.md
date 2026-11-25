# Tasks: patient search on the server (spec 040)

Date: 2026-11-13. `plan.md` approved by the founder on 2026-11-13, with D1 to D5 as recommended.

## Slice A: the API and shared types

- [x] A1 T0 against the API as it is (`a4de0bee`), in a sealed job, on the in-memory and PostgreSQL tiers: `GET /patients?labelContains=SYN`
  answers 400, and the existing `sort=label` case passes. If it answers 200, stop and bring it back to the founder (plan, T0).
  - Done 2026-11-13: every `labelContains` request answered 400 `VALIDATION_ERROR` on both tiers, refused as an unknown key (field
    `(request)`); `sort=label` passed. Nothing to bring back.
- [x] A2 Write T1 to T10; run them against the code as it is and see each fail for the reason it tests (T5's refusals and T8's
  past-the-schema calls may pass today; say which).
  - Done 2026-11-13 in a sealed job against the code as it was. Shared types: the 4 new tests failed (`patientLabelSearchSchema` missing),
    44 others passed. In memory: 14 failed, all new: T2 to T5 (4) got 400 where they expected 200; the 7 cases of T6 named the field
    `(request)`, not `labelContains`; the repository spec's 2 counted 3 where they expected 2 and 0 (the search was ignored); and T10,
    below. PostgreSQL: 15
    failed, all new: the same API cases, T7 (400), T8 (the control found every patient), T9 (1,502 where 12 was expected).
  - T10 first failed for another reason: the fake route it called takes no query, and the input boundary refuses any query there (400).
    It now calls a fake route that declares one. It holds today: the API log already drops the URL. It passes before and after the
    change by design, and A5 shows it can fail.
- [x] A3 `patientLabelSearchSchema` and `labelContains` in `packages/shared-types` (PS-1, PS-6).
- [x] A4 The repository contract, the in-memory list and the PostgreSQL list (PS-2, PS-3, PS-4, PS-7, PS-9); the service passes the
  parameter through.
  - Done 2026-11-13. The same job: shared types 48 of 48; in memory 53 passed, 14 skipped (PostgreSQL-only); PostgreSQL 69 passed, 1
    skipped, as before. The unfiltered list's SQL hash in the query-plan suite is `c6b9f3de…` before and after. The search binds its text
    as parameter 5, a string. At 1,502 patients it ran in about 1 ms with 68 shared buffer hits.
- [x] A5 Deliberate breakages, one at a time, after a control run that passes (plan, "Deliberate breakages (slice A)").
  - Done 2026-11-13 in a sealed job, after control runs that passed (65, 47 and 4 tests). 14 changes, each applied only where its text
    occurs once, run against its named test, then restored; the tree was clean afterwards. All 14 turned red: the page, total and
    past-the-end predicates each made always true; `lower()` dropped on the text and on the label; `LIKE` without escaping; the in-memory
    filter removed, made case-sensitive, and its tenant filter removed; the alphabet widened to `%` and `_` (shared schema and API); the
    list schema made non-strict (`sort=label`); `includeMerged` ignored when searching; the request serializer given the URL. The last is
    also caught by the requests the privacy test already made.
  - The expected survivor, as planned: `tenant_id = $1` removed from the page statement on PostgreSQL. T4 stayed green there, because
    row-level security still hid the other tenant. The in-memory tier has no second layer, and removing its tenant filter turned T4 red.
- [x] A6 Full local loop in sealed jobs, including the database and storage tier in its shards and the query-plan suite; gitleaks.
  - Done 2026-11-13 on `88adbf52`; numbers in `docs/verification/2026-11-13-patient-search-api.md`. Everything passed except three tests
    in two files this change does not touch: `lab-reports-capture.e2e-spec.ts` "while the CPUs are busy", which fails the same way on
    unchanged main run alone beside it, and `readiness.pg-spec.ts`, two timeouts under parallel shards, 11 of 11 alone. The PostgreSQL
    plus S3 tier ran in six shards because three did not fit the 15-minute job on a busy host. Not run: the browser tier (no Chromium in
    the job image), `test:ig`, hosted CI.
- [x] A7 `docs/lab-report-reader.md:247`; verification record; status fragment.
  - `docs/verification/2026-11-13-patient-search-api.md`, `docs/status/2026-11-13-patient-search-api.md`.

## Slice B: the roster (after slice A's PR)

Written 2026-11-25 from the plan, after slice A merged (#390). P2: nothing runs in this session, so CI is the first run of every test here.

- [x] B1 `searchPatients` in `apps/frontend/src/lib/api.ts`: the text checked with `patientLabelSearchSchema` and refused without a
  request (`SearchTextError`); `page`, `pageSize=20`, `order=desc`, `labelContains`; the envelope checked as `listPatients` does; every
  other answer is one failure, `PATIENT_SEARCH_FAILED`.
- [x] B2 `apps/frontend/src/hooks/usePatientSearch.ts`: one search at a time; a new search, a changed text or leaving the page aborts the
  last, and a late answer is dropped (PS-12); `more` pages the current search.
- [x] B3 `PatientRoster.tsx` (PS-10, D4): typing filters the loaded rows at once; while pages remain, Search all patients and Enter ask the
  server; only a 200 replaces the rows and says "Searched all patients: N matches."; any other answer keeps the loaded rows, their filter
  and their sentence, with one line and Retry; a refused text says which characters the field takes.
- [x] B4 Tests: `PatientRoster.test.tsx` (new), `PatientsPage.test.tsx` (wording), `e2e/patient-search.spec.ts` (new: 25 patients, the
  oldest found; keyboard only). 401 is not a fallback case: it ends the session (`AuthProvider`), so the test list leaves it out.
- [ ] B5 Breakages, one at a time, each against its named test, in a place where tests run (the open defect-injection list): the
  sentence claiming "all" on a non-200 (the failure cases); the fallback removed (the failure cases); the text sent unchecked (the refusal
  case); the abort removed (PS-12); the late-answer check removed (PS-12). The founder's browser check from the written steps in
  `docs/verification/2026-11-25-patient-search-roster.md`.

## Slice C: the two pickers (after slice B's PR)

Written 2026-11-25 from the approved plan, after slice B merged.

- [x] C1 `PatientSearchField` (`apps/frontend/src/components/patients/PatientSearchField.tsx`): reusable search input, "Search all patients"
  button (Enter searches without submitting any outer form), local refusal message with 0 requests, status sentence, "More matches" paging,
  Clear action, and inline error with Retry, wired to `usePatientSearch`.
- [x] C2 `WorkspaceConversation.tsx` (PS-11, PS-12): mounts `PatientSearchField` above `PatientPicker`; passes matches while a 200 search
  holds; keeps `selectedPatient` selectable across non-matching searches and after clearing a search-selected patient; `PatientPicker.tsx`
  unchanged.
- [x] C3 `UploadReportPage.tsx` (PS-11, PS-12): mounts `PatientSearchField` above `PatientPicker` inside the upload form without interfering
  with outer form submission; passes matches while a 200 search holds; keeps `selectedPatient` selectable across non-matching searches and
  after clearing a search-selected patient; hides `PatientPaging` while matches hold; `PatientPicker.tsx` unchanged.
- [x] C4 Tests: `PatientSearchField.test.tsx`, `WorkspaceConversationSearch.test.tsx`, `UploadReportPageSearch.test.tsx` (failing-before
  and passing-after covering 200, fallback + Retry on 400/403/429/500/network/malformed, local refusal with 0 requests, PS-12 abort/stale
  drop, Enter not submitting outer form, clearing, and `selectedPatient` survival); `PatientPicker.test.tsx` unchanged and passing; 1
  synthetic search case each in `e2e/upload.spec.ts` and `e2e/upload-navigation.spec.ts`.
