# Feature Specification: One-screen workspace (OSW)

**Feature Branch**: `feat/one-screen-workspace`

**Created**: 2026-10-28

**Status**: Approved 2026-10-28 ("Yes, build it") from the third mockup: one box, the mascot, the landing's folds and A/C/G/T letters. Preview first ("Preview first"): development builds only.

**Input**: The separate Reports and Upload pages make uploading feel like a whole screen instead of a feature. The product's idea is an easy interpretation with an easy tool: one screen, like Claude or ChatGPT.

## Decisions

- **D1, where:** a new route, `/local-workspace`, only in development builds on `127.0.0.1`, the same gate as the chat preview. Production routes, the Reports page and the Upload page are unchanged.
- **D2, layout:** a thin bar (logo; New, Past reports, Account) and one column. No sidebar, no site header or footer. The start view shows the mascot, "Which report should we read?", and one box.
- **D3, upload as a feature:** the box takes a dropped or attached file. The file shows as one line: name, "for" a patient chosen in place, and a "Synthetic" checkbox. Sending uploads through the existing validated intake (`submitReport`), then asks the optional question.
- **D3a, a new patient in place:** the patient choice ends with "New synthetic patient…", which asks for a label (checked by `patientLabelSchema`) and creates it with the existing `createPatient` before the upload. A retry with the same label reuses the request id, so it never makes a second patient. Added during the build: with no patients, the first version sent people to the Upload page.
- **D4, the synthetic confirmation stays.** The checkbox is the only place a person confirms the data is synthetic; the API never receives it. It is a small checkbox on the file line, required before sending.
- **D5, report type from the file:** `.json` is a structured report, `.pdf` is a lab report (accepted only in owned storage mode, as today). Any other file, including a VCF, is refused: no raw genomic data is stored (#154, 2026-10-28).
- **D6, answers:** the existing synthetic chat engine (`useSyntheticChat`), shown with a small mascot beside each answer and labelled as a sample. Its three fixed questions are offered as buttons, because the engine answers nothing else.
- **D7, past reports:** a panel (the existing `ContextDrawer`) with the first page of reports: file name, then status as a word in color.
- **D8, account:** a menu with Usage (administrators), Settings, Overview and Sign out.
- **D9, brand:** the landing's two folds and A/C/G/T letters, faint, behind everything; the shield logo on the seafoam plate in dark mode.
- **D10, roles:** any signed-in member opens it. Attaching is offered only to writer roles; others can still ask.

## Out of scope

- Replacing `/reports` or `/reports/upload`, or any production route.
- Real interpretation (the engine stays synthetic), any backend change, upload recovery after a reload (the Upload page keeps it, and the box links there when an upload was interrupted).

## User Scenarios & Testing

1. **A clinician uploads and asks (P1).** Attach a `.json` report, keep the patient, tick Synthetic, ask a question. **Acceptance:** the line shows "Uploading…", then "Received and verified"; then a sample answer appears beside the mascot.
2. **Nothing to send (P1).** **Acceptance:** with a file but no Synthetic tick, or no patient, Send is disabled and says why; with no file, a question alone goes to the sample engine.
3. **A reader (P2).** **Acceptance:** no attach control; the question box works.
4. **Past reports (P2).** **Acceptance:** the panel lists reports with status words; it closes with Escape and returns focus.
5. **Failure (P2).** **Acceptance:** a refused upload shows the existing message on the file line and keeps the file for a retry.

## Requirements

- **OSW-1** Brand rules hold in both themes: tokens only, status as words, no badges, 44 px targets; no axe violations.
- **OSW-2** Uploads go only through `submitReport`, validated by `productUploadSchema`.
- **OSW-3** The route and its link exist only in development builds on `127.0.0.1`.

## Verification note

The browser suite runs against a production build, where this route does not exist, so it checks OSW-3 (no route, no link). The page's own behavior is covered by unit tests on the real route table. Axe ran in the live development page instead: start view with a file attached, answer view and Past reports panel, light and dark, no violations (2026-10-28).
