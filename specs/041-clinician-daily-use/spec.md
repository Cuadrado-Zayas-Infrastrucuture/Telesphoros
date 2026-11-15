# Feature Specification: Easier daily use for clinicians (DU)

**Feature Branch**: `fix/ui-walk-2026-11-15` (PR A); later slices get their own branches

**Created**: 2026-11-15

**Status**: Plan approved by the founder 2026-11-15 ("Yes, spec + quick fixes"), after a clinician walkthrough of a build equivalent to staging. Slice A in progress; slices B and C not started.

**Input**: "make every function easier to use, access and to find, as if you were a clinician who works with it daily." A walkthrough on 2026-11-15 of `main` at `19a9d310` (signed in as the synthetic clinician alice, at 1280 and 390 px, light and dark) found:

1. **Drug picker:** "li" offers lipase, lindane, lithium, licorice, lime oil and lidocaine; lisinopril needs "lisin". The list grew to 6,862 ingredients (spec 029 Amendment 1), so short searches fill with rarely prescribed names.
2. **Medication form:** a clinician can fill the whole form, and only Save answers "Medication recording is temporarily paused". `MEDICATION_WRITES` defaults to `disabled` and staging leaves it so (`docs/ops/medication-write-fence.md`).
3. **Two ages on one record:** the banner shows the exact age from the full date of birth; the demographics table beside it shows "46 (from the birth year; can be one year high)". Near a birthday the two disagree.
4. **Reports:** opens as a full-screen overlay, and closing it lands in the chat, not on the page the clinician came from.
5. **Navigation:** Patients is a page, Reports an overlay, Follow-ups a side drawer; "Back to chat" is the only back link on the patient pages.
6. **Smaller things:** "Retry stored results" is offered when report processing is off, where retrying cannot help (staging leaves `LAB_REPORT_PIPELINE` unset, so off); the date of birth is `1980-04-12` beside times like "Nov 15, 2026, 1:48 PM"; at phone width the "Open a patient" line on the chat home leaves a tall gap.

Checked and not a defect: the two Refresh controls on Reports do different things (the report list; the patient options of the filter), each with its own label.

## Slices

- **A, quick fixes (this branch):** items 1, 3 and 6. Front end and the shared ranking only. No API, schema, setting or infrastructure change.
- **B, say "paused" before the form:** item 2, by the pattern of spec 037 (an availability read the write also uses). Needs an API change; its own spec amendment and PR.
- **C, one way to move around:** items 4 and 5, together with spec 040 slices B and C (find a patient from anywhere). Needs a navigation decision from the founder; not started.

## Decisions (slice A)

- **D1, products sold under a brand name rank first among equal matches:** `rankDrugs` keeps its levels (whole name, start of name, start of a word, anywhere; a name match before a brand match at the same level) and, within a level, puts ingredients that carry at least one brand alias before those without, then shorter names, then alphabetical. Measured on the bundled list `cb19c1d2` for 93 commonly prescribed generic names (an assumption: the list is the author's, not a dispensing statistic): mean letters typed before the drug is among the first six went from 3.05 to 2.65, and drugs found by the third letter from 75 to 85. "li" now offers lisinopril; lithium needs "lit". Ranking by brand count measured 2.53 but found fewer by the third letter (83) and is harder to explain, so it was not chosen. Nothing changes in what is stored (D2 of spec 029).
- **D2, one age, from the full date:** the demographics table shows the exact age from the date of birth, as the banner does (`exactAge`). The year-based `ageYears` is shown, with its caveat, only when the date cannot be read.
- **D3, a date of birth reads like the other dates:** shown in the reader's locale with the medium date style ("Apr 12, 1980" in US English), formatted from its year, month and day in UTC so no time zone can move it a day. The form keeps the native date input. Follow-up due dates keep their date-and-time-zone form ("2026-11-01 (America/Puerto_Rico)"); the zone is part of what they say, so they are left to slice C.
- **D4, no retry where retrying cannot help:** when the results read answers 503 `PIPELINE_DISABLED`, the section says so as a status, not an alert, and offers no retry. Any other failure keeps the alert and "Retry stored results". The page already re-reads when it regains focus.
- **D5, the chat home link keeps its 44 px target without stretching the line:** the "Open a patient" item becomes a wrapping row (link, then text), so the target stays and the text keeps its line height.

## Out of scope

Enabling medication or follow-up recording anywhere; the three earlier boundaries (follow-up writes refused in production, no clinician names stored, lists never decrypt identity); the marketing site; development-only pages; the report-reader launcher (`pnpm demo:review` sets `LAB_REPORT_PIPELINE=enabled` without the engine; separate fix).
