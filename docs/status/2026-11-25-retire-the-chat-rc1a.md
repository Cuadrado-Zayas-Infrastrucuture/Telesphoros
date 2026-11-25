# Retiring the chat, RC1a: Attach a report and Settings are pages (spec 052)

Date: 2026-11-25

The first of the two slices in `specs/052-retire-the-chat/spec.md`, approved on 2026-11-25 with RC-D1 to RC-D5 as recommended.

- **Attach a report is a page** (RC-3, RC-D3): `/reports/upload` renders in the main area with "Back to home", titled "Attach a report".
  It used to open as a drawer, "Resume report upload", over the chat.
- **Settings is a page too**, with "Back to home". It used to open as a drawer, "Account preferences", over the chat.
- **Every attach link goes to the upload page** (RC-2): the home's quick action, Reports' "Attach a report" (was "Attach report in
  chat") and the empty list's "Attach the first report" (was "Attach first report in chat").
- **Help:** a new screen, `upload`, for the upload page. The draft article "Attaching a report" names the page instead of the chat, and
  links to it. It stays a draft for the founders to sign.

The chat is still reachable from the sidebar, and keeps its draft while other pages are visited; RC1b removes it. Records:
[verification](../verification/2026-11-25-retire-the-chat-rc1a.md). No backend, API, migration or Terraform change.
