# Plan: the walkthroughs describe the app without the chat

Date: 2026-11-25

Status: **approved by the founder on 2026-11-25: WT-D1 and WT-D2 as recommended.** Plan only: no document, code or test changes.

## 1. Why

Spec 052 retired the chat (#479, #481). Two documents still walk a person through it:

- `docs/start-here.md`, section 3 "Walk through the product". This is the first thing a new person follows after starting the local
  demo, and it says "it opens the chat", "Choose **Chat** in the sidebar" and "close **Report history** to return to chat".
- `docs/investor-demo.md`, the local storage prototype: the "Scope" paragraphs, the five-minute table and the rehearsal checks. It says
  "starts in **chat**", "Attach D01 in chat", "Return to chat", and points to a recording of the chat-first app.

Someone who follows either today stops at the first step: there is no Chat in the sidebar. The flow those steps describe still exists.
It now runs through the upload page, Reports and Follow-ups, and `product-demo-e2e/fixture-flow.spec.ts` drives it in CI on every PR.

## 2. What changes and what does not

| Document | Section | Change |
| --- | --- | --- |
| `start-here.md` | 3, steps 2 to 4 and the follow-up paragraph | Rewritten to the current screens (section 3 below) |
| `investor-demo.md` | "Scope (local storage prototype, fallback)", its first two paragraphs | The app starts on the worklist home; attaching is a page; Follow-ups is a page, not a panel over the chat |
| `investor-demo.md` | "Five-minute presentation", the **Action** column and the paragraph above the table | The same steps through the current screens |
| `investor-demo.md` | The **Presenter wording** column | As WT-D1 decides |
| `investor-demo.md` | "Rehearsal" checks and the media-package paragraphs | "chat intake" becomes "attach a report"; the recording as WT-D2 decides |

Unchanged:
- the staging demonstration at the top of `investor-demo.md` (the computed result);
- every boundary sentence (fictional patients, fixed samples, no computation, in-app reminders only);
- "Next delivery slices" and the setup in `start-here.md` sections 1, 2, 4 and 5;
- the verification records the documents link to, which stay as dated history.

No code, test or route changes.

## 3. Proposed steps (`start-here.md`, section 3)

The steps are taken from the screens as built and from the order `fixture-flow.spec.ts` follows:

1. Sign in as alice (unchanged).
2. "Signing in opens the worklist home. Choose **Attach a report**. On that page, choose **Add a synthetic patient**, enter
   `SYN-ONBOARDING-01` in **Synthetic patient label** and choose **Add patient**. The new patient is selected. Save the fictional
   demographics now, or add them later on the patient page."
3. "Choose **Report type** and the original synthetic PDF at `data/fixtures/lab-reports/captures/D01/source.pdf`. Confirm **synthetic
   data only** and choose **Upload report**. **Report received** shows its reference."
4. "Choose **View reports** and open `source.pdf` for `SYN-ONBOARDING-01`. **Report details** shows **Upload verified**. Choose **Back to
   reports** to close it. File verification confirms storage, not clinical interpretation. The storage demo does not run capture
   review, evaluation or a live model."
5. "**Help**, in the sidebar, explains each page in plain words." (new, one line)

Follow-up paragraph:
- "On the patient page, add a recorded medication, choose **Schedule follow-up**, and save a goal, date, timezone and responsible
  clinician. The home lists it under **Follow-ups assigned to you**. **Open follow-up** there, or on the **Follow-ups** page in the
  sidebar, opens its documentation form."
- The rest of the paragraph is unchanged: explicit save, in-app reminders only, no refresh.

The five-minute table follows the same route. The second upload (D08) starts from **Attach a report** on the home. **Follow-ups** →
**Assigned to me** and **Upcoming** and **Recorded treatment responses** are on the Follow-ups page. Each "Return to chat" becomes
"Back to home".

## 4. Decisions for the founder

- **WT-D1. The presenter's spoken lines** in the five-minute table. They are your words for investors. **Decided 2026-11-25: as recommended.**
  - **Recommended:** I change only the two lines that name the chat: the 0:00 scene, "Introduce the chat workspace", and the 3:50
    scene, "Return to chat". I draft their replacements and mark both in the PR for you to reword. Every other spoken line stays word
    for word, since none depends on the chat.
  - **Alternative:** I change only the Action column and leave the whole wording column to you.
- **WT-D2. The narrated backup recording**, `chat-first-2026-11-02`. It shows the chat, so it no longer matches the live demo, and the
  document tells the presenter to fall back to it if the live demo fails. **Decided 2026-11-25: as recommended.**
  - **Recommended:** mark it as historical, like the earlier recordings already are. Add to the pre-meeting checks: "record a new
    backup from the current app before the next meeting". Recording happens outside git, on your machine; this slice makes none.
  - **Alternative:** keep it as the current backup, with one sentence saying it shows the retired chat.

## 5. The slice (one docs PR)

- `docs/start-here.md` section 3, as in section 3 above.
- `docs/investor-demo.md`, as in section 2 and the decisions.
- One status fragment.

## 6. How this was checked

Read from `main` at 1a9c1436:
- `start-here.md`, `investor-demo.md`;
- the screens' own words in `UploadReportPage.tsx`, `AddPatientPanel.tsx`, `UploadReceived.tsx`, `ReportsPage.tsx`,
  `ReportDetails.tsx`, `SyntheticReportDemo.tsx`, `HomeFollowups.tsx`, `FollowupInbox.tsx` and `WorkspaceSidebar.tsx`;
- the order of `product-demo-e2e/fixture-flow.spec.ts`.

No code ran, and no browser was opened. The founder's run of the demo is still what shows the steps work on the meeting machine.

Seen in passing and left out: the sidebar's local-only **Chat preview** entry (`/local-interpretation`, shown only where the local workspace is
available). It is a separate preview, not the retired chat; whether its name now confuses is a question for another slice.
