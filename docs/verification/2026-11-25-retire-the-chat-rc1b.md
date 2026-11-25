# Retiring the chat, RC1b: the chat removed (spec 052), 2026-11-25

Branch `claude/052-rc1b-remove-the-chat`, from `main` after RC1a (#479) merged. Synthetic data only. P2: no code ran in the session that
wrote this; CI is the first run of every test named here.

## What changed

| File | Change |
| --- | --- |
| `app/routes.tsx` | `/chat` sends the person to `/workspace` (RC-5, RC-D2). The signed-in pages no longer sit inside a frame that keeps a conversation in memory |
| `components/layout/WorkspaceSidebar.tsx` | No Chat entry, for any role (RC-6). Help stays |
| `lib/words/shell.ts`, `docs/design/spanish/ls2-shell.md` | The word `chat` removed from the shell's table and from the founders' list, so LS2b has one word fewer |
| `lib/localWorkspace.ts`, `lib/workspaceEvents.ts` | `CHAT_PATH`, `announceNewChat` and `onNewChat` removed |
| `packages/help-content/src/help.ts`, `help.en.json`; `lib/helpSearch.ts` | The screen `chat` removed; `/chat` is no screen of Help's |
| `components/settings/PreferredName.tsx` | The hint says where the preferred name is shown (the account at the foot of the sidebar), not "your chat welcome" |
| Removed (RC-D5) | `pages/WorkspacePage.tsx`, `components/workspace/WorkspaceConversation.tsx`, `ConversationEntries.tsx`, `ConversationWelcome.tsx`, `RemovedAttachmentNotice.tsx`, `hooks/useRemovedAttachment.ts`, `lib/workspaceFileRule.ts`, and their tests |

Not changed: the upload page and its recovery; the local preview (`/local-*`, "Chat preview"); the public landing page's copy, which still
describes the chat home (see "Not done").

## Tests added or changed

| Test | Where | Covers |
| --- | --- | --- |
| `/chat` lands on the home for a clinician and for a member with no role, never on an error | `src/app/retiredChat.test.tsx` (new), `e2e/workspace-home.spec.ts` | RC-5 |
| No box for typed questions on the home or the upload page | `src/app/retiredChat.test.tsx`, `e2e/workspace-home.spec.ts` | RC-1 |
| Signing in from the home page lands on the worklist; an administrator stays | `src/app/retiredChat.test.tsx` (moved from `WorkspacePage.test.tsx`) | spec 049 W-D5 |
| No Chat in the sidebar for any role; Home, Help and the destinations | `WorkspaceSidebar.test.tsx`, `routes.test.tsx`, `e2e/workspace-home.spec.ts`, `e2e/sidebar.spec.ts`, `local-e2e/sidebar-workspace.spec.ts` | RC-6 |
| Home's quick action opens Attach a report | `e2e/sidebar.spec.ts`, `local-e2e/sidebar-workspace.spec.ts` | RC-2 |
| `/chat` is no Help screen | `lib/helpSearch.test.ts` | Help |
| A lost patient-create response replays the same identity and creates the patient once, now started from the Patients page | `e2e/workspace-home.spec.ts` | kept from the chat's cases |
| The safe-area check uses the home's quick action instead of the chat's Send | `e2e/safe-area.spec.ts` | layout |
| The consent bar leaves Attach a report usable without a decision (was the chat) | `e2e/storage-consent.spec.ts` | consent |
| Every suite that attached through the chat attaches on Attach a report, choosing the patient by paging its list | `storage-e2e/structured-preview.spec.ts`, `product-demo-e2e/attach-report.spec.ts` (was `chat-upload.spec.ts`), `product-demo-e2e/workflow-polish.spec.ts` | RC-2, RC-4 |
| Suites that started at `/chat` start at `/workspace` | `storage-e2e/patient-medications*.spec.ts`, `storage-e2e/workflow-regressions.spec.ts`, `medication-fence-e2e/medication-fence.spec.ts`, `product-demo-e2e/followup*.spec.ts`, `product-demo-e2e/patient-results-unavailable.spec.ts` | — |

## Removed with the chat

Each case below tested only the chat, which no longer exists. Where the same rule still holds elsewhere, the test that proves it there is named.

### `src/pages/WorkspacePage.test.tsx` (file removed, 43 cases)

One case moved to `src/app/retiredChat.test.tsx`: "signing in from the home page lands on /workspace … and an administrator stays on the home page". The other 42:

- uses a preferred name set in account preferences for the chat welcome
- shows a generic welcome when a preferred name has not been set
- opens patient creation on the patient page instead of inside chat
- preserves the unsent question and attachment across patient creation navigation
- opens Settings as a page, not a dialog, and keeps the chat draft when the clinician returns
- opens Attach a report as a page, not a dialog, with the way back home
- opens Reports as a page, not a dialog, and keeps the chat draft when the clinician returns
- keeps a report note with its upload without treating it as an interpretation question
- shows a failed upload inside the reopened details dialog and retains its note for retry
- removes an attached file from its chip in the message box, with Undo
- cancels a failed upload: the server cancels the attempt first, then the report that never got its file is removed
- keeps the report, and says why, when the server does not acknowledge the cancel
- offers no cancel for an upload that has not failed
- says "Upload not finished" for a recent report whose file never arrived, and removes it after a second step
- offers no removal for a recent report whose file is stored
- requires fresh confirmation after replacing a file
- can select the same file again after removing it
- loads later patients for an attachment, retries a failed page and retains the selected patient
- opens report details over chat on attachment without starting an upload
- keeps a dismissed attachment and requires its details to be confirmed before uploading
- renders on a host that is not the local preview, with the empty-state heading and the synthetic notice (CH-1)
- is open to a member with no role, who can type but not attach
- shows a typed question as a note, never an answer, and makes no network request (CH-4)
- never reaches the sample engine, and offers no sample-question buttons (CH-5)
- opens the patient page from report details and explains the label rules there
- locks patient creation, retries with the same identity and returns to the attachment to upload once
- can undo removing an unsent attachment without losing the selected patient or note, and sends nothing by itself
- expires the attachment Undo after eight seconds
- keeps the attachment Undo while the pointer is on it and starts the clock again when the pointer leaves
- a replacement attachment supersedes the removed file instead of leaving an Undo that restores stale input
- needs the synthetic confirmation before it sends (D5)
- sends an attached JSON report once, with the confirmation, and shows it with its status word (CH-3)
- "Check status" reloads the known report and shows its new status word (CH-3)
- offers only the file types this build accepts in the attach picker, so a PDF is not offered and then refused (CH-6)
- refuses a PDF without owned-storage mode, naming the local preview, and uploads nothing (CH-6, D4)
- refuses any other file type, as the Upload page does (CH-6)
- says so when the patient list fails, and Retry loads it without a reload, which would sign the tab out
- two similar patients: none is chosen for the clinician, and nothing is sent until one is (specs/038 D2)
- an upload stays with the patient it was sent for: the choice is locked while it is sent, and a later choice does not move it
- says what the chat does before anyone types: questions are not answered, and the supported tasks are listed (specs/038 D3)
- a member with no role is told the same, and is offered neither attaching nor a patient record
- Chat in the sidebar, on the chat itself, starts an empty conversation, as "New chat" did (spec 049)

### `src/pages/WorkspaceUploadLifecycle.test.tsx` (file removed)

- keeps the original attempt through unconfirmed Stop and refuses fresh work until cancellation is acknowledged
- New chat aborts the old byte transfer, retains recovery, and never requests server cancellation implicitly
- patient navigation keeps the owning conversation and its upload alive

### Other unit files removed

- `components/workspace/ConversationWelcome.test.tsx`: "carries one signal-colour line, as decoration under the heading (specs/043 D3)";
  "keeps the words that say a typed question is not answered".
- `lib/workspaceFileRule.test.ts`: "offers .json alone in a published build, and refuses nothing it offers"; "also offers .pdf in
  owned-storage mode, and refuses nothing it offers". The upload page has its own file rule (`productUploadSchema`, `storage-e2e/storage.spec.ts`).

### Browser cases removed

- `e2e/workspace-home.spec.ts`:
  - "Chat on the chat itself opens an empty conversation, as New chat did (spec 049)";
  - "a typed question gets the note, never an answer, and sends no request (CH-4, CH-5)";
  - "a JSON report goes up once with the confirmation, shows its status word, and "Check status" reloads it (CH-3)". One upload with
    the confirmation is proved on the upload page (`e2e/upload.spec.ts`, `e2e/dashboard-guide.spec.ts`);
  - "a PDF is refused with a message naming the local preview, and nothing is uploaded (CH-6)";
  - "no WCAG A/AA violations: empty, file attached, and with a note" (light and dark). The home's own axe checks are in
    `e2e/worklist-home.spec.ts`;
  - "nothing scrolls sideways at 390, 768 and 1280 px" (the chat's three states);
  - "a writer adds one synthetic patient; it shows on the Patients page and in the chat choice; a bad label sends nothing". Adding a
    patient and refusing a bad label are in `PatientsPage.test.tsx`;
  - "attachment Undo restores the file, pauses for keyboard focus and expires without a request".
- `storage-e2e/workflow-regressions.spec.ts`: "chat retries lost registration, declaration and committed-byte replies as one upload";
  "chat checks the known report after twenty older reports"; "a completed chat upload allows an intentional second upload of the same
  file"; "changing a failed chat attachment keeps cancellation available before starting another upload". The upload page's
  counterparts are in `e2e/upload.spec.ts` ("lost registration and transfer replies recover one JSON report without a second transfer",
  "… and a new upload gets a new report", "a refused transfer retains form inputs and retries for the same report", "a different patient
  or file after a reload is refused until the interrupted upload is finished or cancelled").
- `product-demo-e2e/workflow-polish.spec.ts`: "replacement, same-file reattachment and failed-upload retry stay clear in chat".
- `product-demo-e2e/followup*.spec.ts`: the lines that typed a chat draft and checked it survived; the rest of each case is unchanged.

## Not done

- **Breakages**, one at a time, in a place where tests run (the open defect-injection list): the Chat entry restored; `/chat` left
  without a route; a typed-question box put back on the home.
- **The public landing page** (`lib/landing/landing-copy.ts`) still says the chat is the home, in English and in the founders' draft
  Spanish. It was already out of date since the worklist became the home (spec 049). Changing it touches founder-written Spanish, so it
  is the founders' call and is not done here.
