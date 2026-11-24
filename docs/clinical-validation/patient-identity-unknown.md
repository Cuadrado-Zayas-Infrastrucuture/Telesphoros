# The patient page when the identity cannot be read

The plan is `docs/design/plans/patient-page-identity-outage.md`, approved by the founder on 2026-11-24 (B-D1 to B-D4 as recommended). This
note is for the pharmacists' review. It changes how a patient is identified on screen. It changes no clinical logic: no result, outcome,
wording, hold or stored row.

## Three pages with no identity banner

The banner shows the name, date of birth, age and sex. It is the second identifier after the synthetic label. The page shows no banner in
three states, and each says so in its own words:

| State | When | What the page says | What can be recorded |
| --- | --- | --- | --- |
| None recorded | No demographics exist for the patient | "No demographics recorded yet." and "Incomplete" | Everything, including the first demographics |
| Erased | The identity was erased | "This patient's identity was erased. …" | Nothing in demographics; the rest as usual |
| **Unknown (new)** | An identity exists but could not be read now: a 503 when the key cannot be opened, another 5xx, a 429, or a network failure | In the banner's place: "The patient's identity could not be loaded, so their name and date of birth are not shown. Make sure this is patient [label] before you act on anything below." In Demographics: "The demographics could not be loaded. Use Retry above." | **Nothing.** Medications are shown but not recorded. The results, decisions and follow-ups wait, with the line "Results, decisions and follow-ups open once the patient's identity has loaded." The genomic profile's "Record a decision" is not shown |

Before this change, the unknown state replaced the whole page with "The demographics could not be loaded. Please retry.", hiding the
guidance as well. A 403, a 404 for a patient who is not available, and a 404 for a missing earlier version still replace the whole page
(B-D1).

## Why nothing is recorded while the identity is unknown (B-D3)

An unknown patient does have a second identifier. It just cannot be shown right now. Recording a medication, a decision or a follow-up with
only the label on screen would treat the patient as if the label were all there is. So the page reads, and does not write, until Retry reads
the identity. "None recorded" is unchanged: there the label is the only identifier that exists.

## What the tests show

The unit tests are in `apps/frontend/src/pages/PatientPage.test.tsx`, block "when the identity cannot be read now".

- **On a 503:**
  - the warning names the label, and there is no banner;
  - the genomic profile and the medications show;
  - none of "No demographics recorded yet", "Incomplete" or "Record demographics" appears;
  - there is no Add medication, and the held line shows;
  - axe finds no violation.
- **Controls:**
  - when the identity is found, the same clinician gets Add medication and the results;
  - with none recorded, the page offers the first version and shows no warning.
- **Retry:** once the identity answers, the banner shows and the holds lift. Retry reads the identity again but not the patient.
- **Failures that still replace the whole page:** a 403, a 404 for a patient who is not available, and a missing version.
- **Network failure:** a network failure behaves like a 503.
- **The decision link:** `GenomicProfileSection.test.tsx` shows that "Record a decision" is not offered while recording is held. Its control
  is the existing test that offers the link. `PatientPage.test.tsx` shows that the page passes the hold on: on a 503, a result's evidence
  opens in the profile and offers no way to record. Its control offers the link once the identity is read.
- **In the browser:** `apps/frontend/e2e/patient-identity-unknown.spec.ts` runs against the real in-memory e2e API, which answers 503 by
  itself. It runs at 375 and 1280 px, with no sideways scroll and no axe violation.

### Defect injection (2026-11-24)

The plan's section 6 asks that each rule be broken and a test be seen to fail. Each defect below was applied alone inside one sealed
`opensandbox-pilot` job, the two test files were run, and the defect was reverted. After each revert the job's tree was back at its upload.
No code change was kept.

- **Commit tested:** `53a7efef`, which is `main` at `7179c7ee` plus the two tests described under the table.
- **Command, in `apps/frontend`:**
  `node node_modules/vitest/vitest.mjs run src/pages/PatientPage.test.tsx src/components/patients/GenomicProfileSection.test.tsx`
- **Baseline:** 67 of 67 tests passed (26 and 41). After the last revert: 67 of 67 again.

| Defect | Tests that failed |
| --- | --- |
| 1. The patient and the demographics load in one `Promise.all` again, and any failure sets the page error | 7 in `PatientPage.test.tsx`: "on a 503, keeps the page up…", "never looks like "none recorded"…", "holds everything that records something…", "holds the profile's "Record a decision" too…", "Retry reads the identity again…", "a network failure is the same as a 503", "has no accessibility violations while the identity is unknown" |
| 2. An identity that could not be read is set to `none` instead of `unknown` | The same 7 |
| 3. One hold dropped: medications `canWrite` no longer waits for the identity | 1: "holds everything that records something…" |
| 4. The warning no longer names the label | 5: "on a 503, keeps the page up…", "holds the profile's "Record a decision" too…", "Retry reads the identity again…", "a network failure is the same as a 503", "has no accessibility violations while the identity is unknown" |
| 5. `GenomicDecisionControl.tsx` ignores the hold | 2: "holds the profile's "Record a decision" too…", and in `GenomicProfileSection.test.tsx` "does not offer "Record a decision" while the patient page holds recording…" |
| 6. The page tells the genomic profile that nothing is held | 1: "holds the profile's "Record a decision" too…" |

The reverse of defect 6, a page that always holds, fails the control "with the identity read, the same result offers "Record a decision"".

**Two tests were missing when this started.** The plan names defects 1 to 4. Defects 5 and 6 were added for the decision link.

- **The test for defect 5 had been lost, and is restored.** The first run was on `main` at `7179c7ee`. There, defects 1 to 4 each failed
  tests, and defect 5 left all 64 tests green. Its test merged with #454 (`bc2fd94`). A merge commit on the branch of #457 (`6853c826`)
  dropped it, so `main` lacked it from `123d3774` on. The code was not affected. The test is back with its text unchanged.
- **The test for defect 6 is new.** With the first test restored, defect 6 left all 1,185 frontend unit tests green: that test supplies the
  hold itself, so nothing showed that the page passes it on. The founder decided on 2026-11-24 to add the page-level test and its control.

## What is not shown

- The browser test does not look for "Record a decision" in the unknown state. The unit tests above do.

- No test runs this against a real KMS outage. The 503 the page receives is the same response, and it comes from the in-memory store, not
  from KMS.
- The wording is English only.
- No usability session has tested whether people read the warning before acting. The workspace usability protocol
  (`docs/design/clinical-workspace-usability-protocol.md`) counts wrong-patient actions, and a later session could include this state.
