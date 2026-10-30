# Feature Specification: A chat-first home with a feature panel, in every build (CH)

**Feature Branch**: `feat/staging-chat-home`

**Created**: 2026-10-30

**Status**: Approved 2026-10-30 ("Chat + left feature panel"; on staging "Status, no answers").

**Input**: The founder opened staging and expected "the chat UI with a side panel with all the features to choose from". Staging is a production build, and the one-screen workspace (specs/016, 021, 022, 023) exists only in development builds on `127.0.0.1`. So staging shows the Reports page beside the sidebar, with no chat at all.

Read at `main` `9a802f40`. The workspace's upload (`submitReport`, the server intake), past reports (`listReports`) and patients (`listPatients`, `createPatient`) are the production pages' own calls, with no host gate. Only the page gate (`LocalWorkspacePage.tsx:54`), its dev-only route (`routes.tsx:43-52`) and the sample chat (`useSyntheticChat`, `syntheticChatTransport.ts:16`) are local.

## Decisions

- **D1, where (founder):** a new production page, `/workspace`, in every build. It is the signed-in home for every role that can open it. The local preview keeps `/local-workspace` and its sample answers, unchanged.
- **D2, layout (founder):** the chat is the main area, and a left feature panel holds everything else. The panel holds New chat, Past reports (the first page, status as a word in color), Patients (the first page, labels only), Upload report, All reports, Usage (administrators), Settings, and the account with Sign out at the bottom. It collapses on desktop and is a drawer on phones. It is the existing `WorkspaceSidebar`, grown, not a second navigation.
- **D3, answers on staging (founder: "Status, no answers"):** there is no interpretation outside the local preview. The pipeline is refused in production builds, so nothing would answer.
  - Attaching a report and sending it uploads through `submitReport`, then shows the report in the conversation with its status word and a "Check status" action.
  - A typed question gets a system note, never an answer: "Interpretation is not available in the prototype yet."
  - No sample answers and no sample-question buttons appear outside the local preview.
- **D4, file types:** as on the Upload page. A `.json` file is a structured report. A `.pdf` is accepted only in owned-storage mode, which staging's published bundle refuses (`scripts/staging/publish-frontend.sh:51`), so on staging the attach control explains that PDFs are local-only. Any other file is refused.
- **D5, the synthetic confirmation stays:** "I confirm this file contains synthetic data only" is required before sending (as specs/016 D4).
- **D2a, add a patient from the panel (founder, 2026-10-30, relayed by the context-restore session: "There is no easy mechanism to add a patient, we should fix that", then "Add to spec 024"):**
  - The panel's Patients section holds a visible "Add patient" control for writer roles.
  - It asks for a synthetic label, checked by `patientLabelSchema`, and creates the patient with `createPatient` and its request id. A retry with the same label never makes a second patient, as on the Upload page.
  - The new patient appears in the section and in the chat's patient choice.
  - Today adding a patient exists only inside `/reports/upload` (`UploadReportPage.tsx:134`) and the local-only workspace.
- **D6, roles:** any signed-in member opens `/workspace`.
  - Attaching is offered only to writer roles. Past reports and Patients are shown only to clinical read roles.
  - An administrator with no clinical role still lands on `/usage`, as today: the chat has nothing for them to do.
- **D7, the old pages stay:** `/reports`, `/reports/upload`, `/usage` and `/settings` are unchanged and reachable from the panel.

## Out of scope

The backend and every gate in it, the pipeline, the local preview's workspace and sample engine, the public landing, report detail views, deployment (a separate step that needs the founder's OK), and any real data.

## Requirements

- **CH-1** In a production build, `/workspace` renders on any host for a signed-in member. Signing in from `/` lands there for writer and clinical read roles. The local preview still lands on `/local-workspace`.
- **CH-2** The panel lists the D2 items the role may use, in that order, and only those. Collapse persists on desktop. On a phone it is a drawer that traps focus and closes on Escape.
- **CH-3** Sending an attached `.json` report with the confirmation calls `submitReport` once and shows the report in the conversation with its status word. "Check status" reloads it from `listReports`.
- **CH-4** A typed question shows exactly the note "Interpretation is not available in the prototype yet." and makes no network request.
- **CH-5** Outside the local preview, no sample answer, sample-question button or `useSyntheticChat` call exists. A test proves the sample engine is not reached.
- **CH-6** Without owned-storage mode, a `.pdf` is refused with a message naming the local preview, and nothing is uploaded. Other types are refused as on the Upload page.
- **CH-7** axe finds no WCAG 2.1 A/AA violations in light or dark. Nothing scrolls sideways at 390, 768 or 1280 px.
- **CH-9** For a writer role, the panel's Patients section shows "Add patient". A valid synthetic label creates exactly one patient (`createPatient` once, with a request id, and a retry reuses it). The patient then appears in the section and in the chat's patient choice. An invalid label is refused before any request. Non-writer roles do not see the control.
- **CH-8** `check:chunks` and `check-foundation` pass: the new page is a lazy production chunk whose name does not start with `Local`.
