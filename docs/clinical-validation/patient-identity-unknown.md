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
  is the existing test that offers the link.
- **In the browser:** `apps/frontend/e2e/patient-identity-unknown.spec.ts` runs against the real in-memory e2e API, which answers 503 by
  itself. It runs at 375 and 1280 px, with no sideways scroll and no axe violation.

## What is not shown

- No test runs this against a real KMS outage. The 503 the page receives is the same response, and it comes from the in-memory store, not
  from KMS.
- The wording is English only.
- No usability session has tested whether people read the warning before acting. The workspace usability protocol
  (`docs/design/clinical-workspace-usability-protocol.md`) counts wrong-patient actions, and a later session could include this state.
