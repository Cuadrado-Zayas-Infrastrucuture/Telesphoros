# Spec 041, slice C: one way to move around

**Branch**: `feat/one-navigation`, from `main` at `19a9d310`. Slices A and D (`spec.md`, `tasks.md` in this folder) are on `fix/ui-walk-2026-11-15`; this file is separate so the two branches do not collide.

**Status**: founder decision 2026-11-15, "Pages everywhere" (over "Minimal fix", which kept the overlays and changed only where closing lands).

**Input**: the 2026-11-15 walkthrough (items 4 and 5 of `spec.md`). Patients opened as a page, Reports as a full-screen overlay over the chat, and Follow-ups as a side drawer with no address. Closing Reports always went to the chat (`WorkspacePage.tsx`, `navigate('/workspace')`), so a clinician who came from a patient record lost it. The patient pages linked only "Back to chat".

## Decisions

- **C1, Reports is a page.** `/reports` renders in the main area like Patients, not in the workspace panel. Its "Report details" side panel stays: it is a detail of one row, opened and closed in place. The browser's Back button returns to wherever the clinician came from.
- **C2, Follow-ups is a page.** A new route, `/follow-ups`, for the roles that read follow-ups (clinician, reviewer), shows what the drawer showed: filters, totals, the response summary and the list. The sidebar entry becomes a link to it and keeps its count of overdue and due today. Opening a follow-up goes to the patient record as before.
- **C3, the chat stays where it was.** `WorkspacePage` already keeps the conversation mounted and hidden while another page shows; nothing typed is lost by visiting a page. Unchanged.
- **C4, pages say where they are, and the chat in progress stays one link away.** A breadcrumb, "Patients / SYN-0001" on a record and "Patients / New patient" on the new-patient form, shows where the page sits. Beside it, and at the top of Reports and Follow-ups, one "Back to chat" link (`BackToChatLink`) returns to the conversation in progress with its unsent question and attachment. The plan first said the sidebar would do that; the unit tests showed it cannot, because the sidebar's "New chat" starts a new conversation, which would lose a half-started upload (for example while adding the patient it belongs to). The record's load-failure state offers "Back to patients" and "Back to chat".
- **C5, short side tasks stay panels.** Account preferences (`/settings`) and Resume report upload (`/reports/upload`) open over the chat as before: they start from the account menu or the chat and return to it.

## Out of scope

Finding a patient from anywhere: spec 040 slices B (roster) and C (upload pickers), approved as their own PRs. The API, the paused notices and every safety statement.

## Checks

- 2026-11-15, sealed sandbox: `verify` exit 0 in 282 s at `d111ca53` (typecheck, lint, format, tests, build, chunk check, knowledge, infra, CI config, workflows). The first run failed on two `WorkspaceSidebar.test.tsx` expectations that still counted Follow-ups as a button; an earlier targeted run caught the "New chat" draft loss that changed C4.
- Walked in a staging-style build at 1280 and 390 px: Reports and Follow-ups open as pages with the sidebar active; a typed draft survives Reports and "Back to chat"; the record shows "Patients / SYN-0001" with "Back to chat".
- Not run: the browser suites (no browser in the job image). Seven browser test files changed with this slice (`e2e/helpers.ts`, `e2e/sidebar.spec.ts`, `e2e/workspace-home.spec.ts`, `product-demo-e2e/followups.spec.ts`, `followup-entry.spec.ts`, `followup-filters.spec.ts`, `chat-upload.spec.ts`; `workflow-polish.spec.ts` is back to `main`) and need the founder's browser run before a PR.
