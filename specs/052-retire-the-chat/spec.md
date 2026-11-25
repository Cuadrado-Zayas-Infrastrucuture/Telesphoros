# Feature Specification: retire the chat (RC)

**Feature Branch**: `claude/052-retire-the-chat-spec` (this specification); each slice its own branch and pull request off `main`

**Created**: 2026-11-25

**Status**: **Draft, for the founder's decisions RC-D1 to RC-D5 (section 6). Specification only: no code, route, setting, migration or
knowledge change.** It is the follow-up that spec 051 H-D5 named: "retiring it is its own slice once attaching has a home outside the
chat". It amends specs 024 D3 and 038 D3, and spec 049 W-D2, as far as the chat is concerned, once approved.

## 1. Why now

The chat was the home (spec 024), then moved to `/chat` when the worklist became the home (spec 049 W-D2), "until the help assistant
replaces it". The help assistant is now in place (spec 051, H1 #468 and H2 #471). What the chat still does, attaching a report, already has
its own page. So the chat is a second, weaker way to do one task, and a box that invites a question it then refuses:

- **A typed question gets "Questions cannot be answered here."** (`WorkspaceConversation.tsx:32`, specs 024 D3 and 038 D3). Help now answers
  how-to questions and refuses patient questions by a tested rule (spec 051 section 5). A second box with a different answer is confusing.
- **Attaching a report has a full page.** `/reports/upload` (`UploadReportPage.tsx`) is a three-step guide: choose the patient (with Add
  patient beside it), choose the file and its type, review and confirm the data is synthetic. It also offers to finish or cancel an upload
  a reload interrupted (`UploadReportPage.tsx:58`). It takes PDF in owned storage mode; the chat refuses PDF.
- **The chat's only extra is a note** (`WorkspaceConversation.tsx:328`), kept in the conversation on screen and never sent
  (`ConversationEntries.tsx:49`). Nothing is lost on the server by retiring it.

## 2. What exists, read at `main` `6c013d75`

| Piece | Where | What matters here |
| --- | --- | --- |
| Route | `app/routes.tsx:45` | `{ path: 'chat', element: null }` inside `WorkspacePage`, which renders the conversation when the path is `/chat` |
| Frame | `pages/WorkspacePage.tsx` | Keeps `WorkspaceConversation` mounted on every signed-in page; opens `/settings` ("Account preferences") and `/reports/upload` ("Resume report upload") as a drawer over the chat, which closes to `/chat` |
| The chat | `components/workspace/WorkspaceConversation.tsx` (456 lines), `ConversationEntries.tsx` | Attach, choose patient, confirm, send; status word and "Check status"; the refusal sentence; interrupted-upload notice linking to `/reports/upload` |
| Sidebar | `components/layout/WorkspaceSidebar.tsx:231-245`; word `chat` in `lib/words/shell.ts:19` | The Chat entry under Home; on `/chat` it starts a new conversation (`announceNewChat`) |
| Links to the chat | `WorklistPage.tsx:43` ("Attach a report"), `ReportsPage.tsx:113` ("Attach report in chat"), `ReportRecordsTable.tsx:148` ("Attach first report in chat") | All three are about attaching |
| Address constant | `lib/localWorkspace.ts:17` | `CHAT_PATH` |
| Help | `packages/help-content/src/help.en.json` | Screen `chat` in five articles; "attach-a-report" says "Reports are attached in Chat."; `helpScreenOf('/chat')` (`lib/helpSearch.ts:13`) |
| Tests | `e2e/workspace-home.spec.ts` (about 20 cases of spec 024), `e2e/helpers.ts:84`, `:96` (`openChat`), `e2e/upload-navigation.spec.ts:30`, `e2e/safe-area.spec.ts`, `e2e/sidebar.spec.ts`; unit: `WorkspacePage.test.tsx`, `WorkspaceUploadLifecycle.test.tsx`, `WorkspaceSidebar.test.tsx`, `WorklistPage.test.tsx`, `ReportsPage*.test.tsx` | What the chat proves today, and what moves to the upload page |
| Not this | `/local-interpretation` ("Chat preview", local builds only, `WorkspaceSidebar.tsx:109`) | The local preview is its own surface and does not change |

## 3. The change

1. **Attaching a report is a page.** `/reports/upload` renders in the main area like Patients and Reports (spec 041 C1), titled
   **"Attach a report"**, with "Back to home". Every link that said "in chat" goes there, and says "Attach a report".
2. **Settings is a page too.** With no chat to open a drawer over, `/settings` renders in the main area, as every other destination does.
3. **The chat is gone.** The sidebar's Chat entry, the `/chat` route's conversation, `WorkspaceConversation`, `ConversationEntries` and
   the code only they use are removed. `/chat` goes where RC-D2 decides.
4. **Help follows.** The screen `chat` leaves the article schema; "attach-a-report" names the page instead of the chat. The articles stay
   drafts for the founders to sign.
5. **The tests move with the work.** What `workspace-home.spec.ts` proves about attaching (one upload with the confirmation, a refused
   file sends nothing, a lost patient-create response, no sideways scroll, no axe violation) is proved on the upload page, where most of it
   already is (`upload.spec.ts`, `upload-navigation.spec.ts`). Cases that only describe the chat are removed with it, each named in the
   verification record.

Rules, each with a test:

| ID | Rule |
| --- | --- |
| RC-1 | No signed-in page shows a box that takes a typed question, except Help. |
| RC-2 | Every "Attach" control on the home, on Reports and in an empty report list opens `/reports/upload`, for writer roles only. |
| RC-3 | `/reports/upload` and `/settings` are pages in the main area, with a level-one heading, and no drawer over another page. |
| RC-4 | An upload interrupted by a reload is still offered to finish or cancel on `/reports/upload` (unchanged behaviour, kept tested). |
| RC-5 | `/chat` never shows an error to someone with an old bookmark (RC-D2). |
| RC-6 | The sidebar's entries are Home, then the destinations; no Chat. Help stays. |

## 4. What this does not touch

The API, every backend file, migrations, Terraform, knowledge and clinical logic; the upload pipeline and its recovery; the local preview
(`/local-*`); spec 040 slice C, except that it then has one picker to change, not two (section 7).

## 5. Slices

| Slice | What | Touches |
| --- | --- | --- |
| **RC1** | The upload page and Settings as pages; every attach link to `/reports/upload`; the sidebar without Chat; `/chat` as RC-D2 says; the chat's code removed; Help's articles and `helpScreenOf` updated; tests moved or removed as section 3.5 | `apps/frontend`, `packages/help-content` |

One slice: the pieces depend on each other (the drawer needs the chat to sit over). If the founder wants it smaller, RC1a can move the
upload page and Settings and repoint the links, leaving the chat reachable only from the sidebar, and RC1b removes it.

## 6. Decisions for the founder

- **RC-D1. Retire the chat now?**
  - **Recommended:** yes. Help answers how-to questions; the upload page attaches reports and recovers interrupted uploads.
  - **Alternative:** keep it until the first usability sessions (direction plan F5) have seen both.
- **RC-D2. What `/chat` does afterwards.**
  - **Recommended:** it sends the person to the home (`/workspace`), so an old bookmark lands somewhere useful.
  - **Alternative:** the not-found page.
- **RC-D3. The upload page's name.**
  - **Recommended:** "Attach a report", the words the home already uses.
  - **Alternative:** "Upload a report".
- **RC-D4. A sidebar entry for attaching.**
  - **Recommended:** none. It stays a quick action on the home and a button on Reports; the sidebar keeps its destinations.
  - **Alternative:** an "Attach a report" entry for writer roles.
- **RC-D5. The chat's code.**
  - **Recommended:** removed in RC1, with its tests, each removed case named in the verification record. Git keeps the history.
  - **Alternative:** left in the repository, unreachable, until a later clean-up.

## 7. Order with other work

- **Spec 040 slice C** (the search in the two upload pickers) is written after slice B (#474) merges. If RC1 merges first, slice C changes
  one picker, the upload page's, and its plan is updated to say so. Neither waits on the other.
- **Spanish (spec 050):** the shell word `chat` (`lib/words/shell.ts:19`) is removed in RC1, so the founders have one word fewer to write
  in LS2b. Nothing Spanish is written here.

## 8. Tests (RC1)

- **Unit:** the sidebar has no Chat entry for any role (RC-6); each attach link's address, for writers only (RC-2); `/reports/upload` and
  `/settings` render as pages with a level-one heading (RC-3); `/chat` lands as RC-D2 says (RC-5); `helpScreenOf` has no `chat`.
- **Browser:** from the home, Attach a report reaches the upload page and one synthetic upload completes; a reload during an upload still
  offers to finish or cancel (RC-4); no page but Help has a text box for questions (RC-1); 375 and 1280 px, light and dark, no axe
  violation; keyboard only.
- **Breakages,** one at a time, in a place where tests run: the Chat entry restored; an attach link pointed at `/chat`; the upload page put
  back in a drawer; `/chat` left without a route. Each must turn a named test red.

## 9. How this was verified

Read from `main` at `6c013d75`: the files and lines in section 2, by search and reading. No code ran.
