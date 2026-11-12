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

## Slice 2: the patient decision workspace

- [ ] T201 (D7, F06, F07) A selected result with its evidence beside it on a wide screen and after it on a narrow one.
- [ ] T202 The evidence actions "Why this applies", "Show the source", "What is missing?" as views of fields the result carries.

## Slice 3: decision and follow-up, comparison, scope, events

- [ ] T301 (F10) A decision and its follow-up as one guided step; each outcome reported separately; only the missing write retried.
- [ ] T302 (F11) Conflicting report revisions with their findings side by side.
- [ ] T303 (F12) The patient filter states its scope.
- [ ] T304 (F13) Render events in the main result view.

## Slice 4: home, accessibility, protocol

- [ ] T401 (F14) A home that lists due follow-ups and results on hold from the existing reads.
- [ ] T402 Accessibility tests for the changed tasks; the clinician usability protocol; the final report.
