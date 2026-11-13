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

## Decisions, slice 2 (`feat/clinical-workspace-2-decision-workspace`)

- **D9, one result open at a time (F03, F06).** Every stored result is a row that always shows the drug, the outcome in plain words and
  the phenotype it rests on, so a list of twenty drugs is read at a glance. The selected result opens below its row. When a page of
  results is first read, the open result is the one a link named (`?result=<id>`), or else the first result of the first evaluation the
  API marks `current`; a result that is not current is never opened for the reader. After that only the reader moves the selection: a
  re-read that finds the open result withdrawn leaves it open, marked not current. Only the open result reads its decision history.
- **D10, the evidence beside the result (F06, F07).** An evidence panel sits beside the open result on a wide screen and after its
  wording on a narrow one, before the decision. Its parts are views of fields the result carries, shown without a click:
  "Why this applies" (or "What the assessment used" for a result with no wording): the gene results the assessment used, and the
  statement that the medication list and demographics were not used, which is true of the engine's inputs today;
  "Show the source": the citation of D5;
  "What is missing?": each gene with no usable result and the result's own reason, with the vocabulary's fixed message and reviewer
  action, grouped as "From the report", "From the guidelines and definitions" or "The assessment", so a gap in the guidelines is not
  read as a gap in the patient's results; a reason with no reviewer action says nothing can be done in the product yet;
  "What changed?": corrections, and whether the guidelines loaded now differ from the set the result used; shown only when there is
  something to say. A gene the result names with no state reads "no state was recorded", never as a normal result.
- **D11, which reasons are about the report.** The grouping of D10 is new and is the front end's own table (`lib/resultEvidence.ts`,
  every reason code placed; a new code fails to compile until it is placed). It changes no outcome. **A pharmacist confirms it before
  release**: the three diplotype reasons (`allele-not-in-definitions`, `no-phenotype-mapping`, `no-gene-definition`) are placed under the
  guidelines and definitions, because their messages name the definitions this system uses.
- **D12, the entry names its patient.** The form that records, corrects or withdraws a decision says "For patient <label> · <drug>".
  The label is the synthetic one the page title carries. A fixed identity bar that stays in view while the page scrolls is **not** in
  this slice: it cannot be judged without a browser.
- **D13, no owner is shown for a hold.** The API names no resolver, owner or due date for a hold, so the page shows none.

## Decisions, slice 3 (`feat/clinical-workspace-3-decision-followup`)

- **D14, a decision and its follow-up are two saves, shown as two steps (F10).** The form for a new decision offers "Then schedule a
  linked follow-up (optional)". Nothing makes a follow-up required. The decision is saved first; only when the history read that follows
  shows the decision the server stored does step 2 open, the existing follow-up form linked to that decision. Step 2 says the decision is
  already saved. If its save fails, the form says so, keeps the draft, and a retry sends the follow-up alone as the same request; the
  decision is never sent again. If it is cancelled, the page says the decision is saved and no reminder exists. If another follow-up form
  is open when the decision is saved, step 2 waits for that form to close and never replaces it. Where follow-up recording is paused, the
  option is not offered and the form says why. A decision whose reply was lost, or that was refused, opens no step 2.
- **D15, what the dates mean (F10).** The review-by date records an intention and creates no reminder; the form says so, and offers that
  date to step 2 as the follow-up's date. The follow-up form says its date is a calendar date in the reminder timezone it names.
- **D16, conflicting sources side by side (F11).** Beside the source choice, a table compares the conflicting sources from what the saved
  history carries: the laboratory's report id, which upload each is, revision and status, when it was saved, how many findings it holds
  and which only it holds. Nothing is preselected and independent review is unchanged. **The history does not carry what each source
  reports for a finding**, so the table says that cannot be compared here; see [dependencies.md](dependencies.md).
- **D17, the filter says how far it reaches (F12).** The patient filter searches the pages this screen has loaded. It now says how many
  that is and whether more remain. There is no server search to call; see [dependencies.md](dependencies.md).
- **D18, render events in the result view (F13).** The open result's summary is the region specs/019 measures. It records display only:
  not reading, agreement or a decision. A result that is not current is not measured, because its wording is folded. The capture is not
  mounted in the synthetic staging, where the route is switched off, and the queue stops for the session when the API answers that the
  route is switched off (503 `PIPELINE_DISABLED`) instead of retrying. The explicit "Reviewed" control of specs/019 is **not** adopted
  here: where an acknowledgement sits beside a decision is a product decision.

## Decisions, slice 4 (`feat/clinical-workspace-4-home-and-protocol`)

- **D19, the home lists the work the API can list (F14, home).** The chat's welcome shows, to the roles that read follow-ups, the open
  follow-ups assigned to the person signed in: patient, medication, when the reminder is due and in which timezone, and the way to open
  it. It is the first three from the inbox's own read; the full list and its filters stay in the sidebar. An overdue reminder is a late
  task, and the section says it is not a clinical warning. No score ranks anything. **Results on hold and results whose guidelines have
  changed are not listed on the home**: results can be read across patients one page at a time, with no way to ask for only those, so a
  list built in the browser would be silently incomplete; see [dependencies.md](dependencies.md), entry 3.
- **D20, accessibility is tested where a rule can test it, and said to be unproven where it cannot.** The changed tasks carry automated
  checks (`vitest-axe` on the home, the patient page with a result and the decision form open, and the source conflict), a keyboard test
  of the result rows, and a focus test of the line that reports the follow-up step's outcome. Contrast, reflow, zoom, real focus order
  and a screen reader's reading need a browser and a person; the protocol is in
  [clinical-workspace-usability-protocol.md](../../docs/design/clinical-workspace-usability-protocol.md).

## Out of scope

Server-side patient search (no contract exists: `patientListQuerySchema` has `page`, `pageSize`, `includeMerged`, `order`); a unified
task queue; assignment or completion of a review; any model-generated explanation; comparison of alternatives; a localisation library;
the local preview pages (`/local-*`), which keep their own behaviour; enabling decisions or follow-up recording in any environment.

## What a reviewer should check by hand

No browser can run in the session that built this, so rendered screens were not inspected: light and dark themes, 1280×800 and narrow
widths, enlarged text, a 20-medicine patient, keyboard order and focus return. The Playwright specs that name the changed controls were
updated by reading, not by running.
