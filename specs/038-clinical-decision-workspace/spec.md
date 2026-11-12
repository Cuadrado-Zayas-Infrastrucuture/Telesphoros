# Feature Specification: Clinical decision workspace (CDW)

**Feature Branch**: `feat/clinical-workspace-1-honest-surface` (slice 1 of 4; one branch and one pull request per slice)

**Created**: 2026-11-12

**Status**: Plan approved by the founder 2026-11-12 ("Approve plan"), after a source audit of the front end at `c996b1a5` and a
re-verification of each finding against that commit. Numbered 038 because 035 and 036 are taken on unmerged branches.

**Input**: A clinician opening a patient has to answer five questions: which patient and assessment is this, what does it support or
withhold, which inputs and source produced it, what is unknown or out of date, and what can be recorded about it. The audit found that the
front end makes several of these harder than the stored data requires. Verified at `c996b1a5`:

| ID | Finding | Where |
| --- | --- | --- |
| F01 | The chat attaches a report to the first loaded patient unless another is chosen | `WorkspaceConversation.tsx` |
| F02 | The chat box invites a question; a typed question gets a fixed note | `WorkspaceConversation.tsx`, `ConversationEntries.tsx` |
| F03 | A stored result's decision controls are three disclosures deep | `PatientResults.tsx`, `StoredResult.tsx`, `DecisionPanel.tsx` |
| F04 | A result's citation is printed as JSON | `ResultDetails.tsx` |
| F05 | "All N drugs evaluated." is green whatever the recommendations say | `lib/resultStatus.ts` |
| F06 | Nothing says which inputs an assessment used; the medication list is beside it | `PatientPage.tsx` |
| F07 | A held result names its reason and the reviewer's action as text only | `ResultsList.tsx`, `AssessmentResult.tsx` |
| F10 | A decision's review-by date creates no follow-up; that is a second, separate form | `DecisionForm.tsx`, `DecisionPanel.tsx` |
| F11 | Choosing between conflicting report revisions shows an id and a time, not the findings | `StructuredFindingsReview.tsx` |
| F12 | The patient filter searches loaded pages only | `PatientRoster.tsx` |
| F13 | The render-event hook is wired only into a test page | `RecommendationSummaryRegion.tsx` |
| F14 | No localisation outside the landing page; accessibility is tested per component | whole front end |

Findings F08 and F09 of the audit have no public contract and are not part of this specification.

## Decisions

- **D1, front end only.** No API route, shared type, migration, clinical rule, vocabulary, role, release gate or deployment setting
  changes. Where the stored data cannot answer a question, the page says so; it does not compute an answer.
- **D2, a patient is always chosen, never assumed (F01).** The chat's patient choice starts empty. A report cannot be sent until a
  patient is chosen, and the details show which patient the report will be stored for. A patient the clinician has just created from the
  chat is still selected for them, because that is their own explicit act (spec 024 D2a).
- **D3, the chat says what it does before anyone types (F02).** Spec 024 D3 stands: outside the local preview a typed question gets a
  note, never an answer, and no request is made. What changes is that the box and the welcome say so first, and the welcome lists what
  can be done here.
- **D4, a result's action is visible with the result (F03).** The stored results load with the patient page. Each result shows, without
  a click, either the way to record a decision or the reason none can be recorded. Decision history stays behind its disclosure, and so
  does the wording of a result that is not current.
- **D5, a citation is read, not dumped (F04).** The guideline, its version, the table, row and column, and the verification state are
  shown as labelled lines, each only when the stored citation carries it; a part it does not carry reads "not recorded", and nothing is
  taken from the knowledge loaded now. The link to the source is offered only when it is an `https` address. Codes, hashes and the stored
  citation as written stay under "Technical provenance".
- **D6, finishing is not a verdict (F05).** A completed assessment reads "Assessment completed." in the page's ordinary colour. Green is
  not used for it. The warning cases keep their wording and colour.
- **D7, later slices.** Slice 2: a patient decision workspace with a selected result, its evidence beside it, and the four evidence
  actions as views of fields the result already carries (F06, F07). Slice 3: a decision and its follow-up as one guided step with each
  outcome reported separately (F10), the conflicting findings side by side (F11), the filter's scope stated (F12), and render events in
  the main result view (F13). Slice 4: a home that lists due follow-ups and results on hold from the existing reads, accessibility tests
  for the changed tasks, and the usability protocol (F14).
- **D8, wording.** Outcome labels, hold messages, reason messages and decision labels are the existing ones (`lib/resultStatus.ts`,
  `REASON_MESSAGES`, `decisionLabels`). New sentences are in English only; no Spanish clinical copy is added, because none has been
  reviewed by a qualified person.

## Out of scope

Server-side patient search (no contract exists: `patientListQuerySchema` has `page`, `pageSize`, `includeMerged`, `order`); a unified
task queue; assignment or completion of a review; any model-generated explanation; comparison of alternatives; a localisation library;
the local preview pages (`/local-*`), which keep their own behaviour; enabling decisions or follow-up recording in any environment.

## What a reviewer should check by hand

No browser can run in the session that built this, so rendered screens were not inspected: light and dark themes, 1280×800 and narrow
widths, enlarged text, a 20-medicine patient, keyboard order and focus return. The Playwright specs that name the changed controls were
updated by reading, not by running.
