# The worklist home, W2: the page (spec 049)

Date: 2026-11-24

Signing in now opens a worklist at `/workspace` for readers, clinicians and reviewers (spec 049 W-D5). The chat it replaced moved to `/chat`
(W-D2). The page has:

- **Quick actions:** Find a patient, Add a patient and Attach a report, each shown only to the roles that may use it.
- **Follow-ups assigned to you,** for clinicians and reviewers. This is the existing section that sat under the chat's welcome, moved here
  unchanged.
- **Held results,** for every clinical read role. It reads `GET /evaluations?current=true&disposition=held` (W1). Each line gives the
  patient, the hold in its fixed words, and a link to the patient's results. A count line gives the server's total when there are more than
  the five shown.

Each section reads its own route and fails on its own, with a Retry that reads only that section. An empty section says so in a fixed
sentence. A route switched off in this environment says "not available" and offers no Retry. Nothing is ranked or written.

Navigation changes:

- In the sidebar, "New chat" became **Home** and **Chat**. On the chat itself, Chat starts a new conversation, as New chat did; from any
  other page it returns to the conversation in progress.
- "Back to chat" on Reports, Follow-ups and the patient pages became **Back to home**.
- Report attachment still happens in the chat, so "Attach report in chat" and the quick action open `/chat`.

The unit tests, the browser suites (`e2e`, `product-demo-e2e`, `storage-e2e`, `medication-fence-e2e`, `local-e2e`) and three walkthrough docs
follow the new addresses. New tests are `WorklistPage.test.tsx` and `e2e/worklist-home.spec.ts`: 375 and 1280 px, light and dark,
keyboard, 44 px targets and heading order.

Frontend and docs only. No backend, route, setting, check or migration change.
