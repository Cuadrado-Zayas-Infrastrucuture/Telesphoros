# Tasks: Clinical decision workspace

Front end only. No API route, shared type, migration, clinical rule, role, release gate or deployment setting changes. The plan is the
decisions in [spec.md](spec.md). One branch and one pull request per slice.

## Slice 1: an honest surface (`feat/clinical-workspace-1-honest-surface`)

- [x] T101 (D2, F01) `WorkspaceConversation`: the patient choice starts empty; the details say which patient the report will be stored
  for, or that none is chosen.
- [x] T102 (D3, F02) `WorkspaceConversation`, `ConversationWelcome`: the box and the welcome say typed questions are not answered; the
  welcome lists what can be done, with the patient link only for roles that may read records.
- [x] T103 (D4, F03) `PatientResults`, `StoredResult`, `lib/clinicianDecisions.ts` (`decisionStanding`): results load with the page; a
  result a decision can be recorded on shows its decision controls; any other says why not and keeps its history behind a disclosure.
  `DecisionPanel` uses the same conditions it always applied, now from one function.
- [x] T104 (D5, F04) `lib/citationView.ts`, `ResultSource`, `ResultDetails`: the citation as labelled lines, "not recorded" for a part
  the stored citation lacks, an `https`-only source link, and the stored form under "Technical provenance".
- [x] T105 (D6, F05) `lib/resultStatus.ts`, `AssessmentResult`: "Assessment completed." in the ordinary colour.
- [x] T106 Tests. New: two similar patients and no automatic choice; an upload stays with the patient it was sent for; the welcome and
  placeholder; no success colour beside a restrictive recommendation; the citation lines, missing parts, cautions and link schemes;
  held, no-guideline and no-recommendation outcomes stay distinct and each says why no decision can be recorded. Changed, because they
  pinned the old behaviour: the upload tests now choose a patient; the result tests no longer click "Recorded results" or "Decision and
  history". No assertion was removed without a replacement.
- [x] T107 Controls, 2026-11-12, in the sealed sandbox. Each of these was applied alone and turned the named tests red, and the
  unmodified code passed: the first-patient fallback restored (2 tests); the completion line green again (2); the decision controls
  behind a click (2); the readable source removed (8); any link scheme accepted (2); the old placeholder (1).
- [x] T108 Results, 2026-11-12, in the sealed sandbox: see the status note `docs/status/2026-11-12-clinical-workspace-slice-1.md`.
- [ ] T109 Not done, and needed before a release: the Playwright suites (`decision-e2e`, `product-demo-e2e`, `e2e`, `storage-e2e`) were
  not run, because the sandbox has no browser; two of their specs were edited by reading. No rendered screen was inspected.
  The pull-request `browser` job runs `e2e`, `local-e2e` and `report-workspace` only: the two edited specs (`decision-e2e`,
  `product-demo-e2e`) are run by neither it nor the nightly job, so a person runs them.
- [x] T110 Hosted run 1 of #384 failed in `browser`: the welcome's "Open a patient" link was 17 pixels tall, under the 44-pixel
  target (`e2e/foundation.spec.ts`). Fixed with the control-height utility; `WorkspacePage.test.tsx` now checks the link carries it.

## Slice 2: the patient decision workspace

- [x] T201 (D9) `ResultsList`, `StoredResult`: rows that always show drug, outcome and phenotype; one result open; the first current
  result (or the one `?result=` names) opens when a page is first read; a re-read does not move the selection.
- [x] T202 (D10, D11, D13) `lib/resultEvidence.ts`, `ResultEvidence`, `EvidenceBlock`: the four evidence parts as views of fields the
  result carries.
- [x] T203 (D12) `lib/patientLabel.ts`, `PatientPage`, `DecisionPanel`, `DecisionForm`: the decision form names its patient and drug.
- [x] T204 Tests. New: what an assessment used, lacked and whose gap that is; a gene with no state is not assumed; an unknown reason;
  "What changed?" only when there is something; twenty-two drugs with one result open and one decision history read; the current
  result opens before a withdrawn one listed above it; a named result opens; the form names its patient. Changed, because selection is
  new: the not-current and mixed-outcome tests open a row first.
- [x] T205 Controls, 2026-11-12, in the sealed sandbox. Each alone turned the named tests red: a report gap filed under guidelines (1);
  a gene with no usable result read as used (1); a gene with no state dropped (1); every result open at once (7); the first listed
  result opened even if withdrawn (5); a re-read moving the open result (3); the form naming no patient (1); changed guidelines not
  reported (1); the result's reason repeated beside the gene's (1).
- [ ] T206 Not done: no browser run; the two-column layout at 1024px and wider, the row buttons' focus ring and the widened page were
  not seen. D11's grouping awaits a pharmacist. No fixed identity bar (D12).

## Slice 3: decision and follow-up, comparison, scope, events

- [ ] T301 (F10) A decision and its follow-up as one guided step; each outcome reported separately; only the missing write retried.
- [ ] T302 (F11) Conflicting report revisions with their findings side by side.
- [ ] T303 (F12) The patient filter states its scope.
- [ ] T304 (F13) Render events in the main result view.

## Slice 4: home, accessibility, protocol

- [ ] T401 (F14) A home that lists due follow-ups and results on hold from the existing reads.
- [ ] T402 Accessibility tests for the changed tasks; the clinician usability protocol; the final report.
