# Retiring the chat, RC1a: the pages (spec 052), 2026-11-25

Branch `claude/052-rc1-retire-the-chat`, from `main` at `6c013d75`. Synthetic data only. P2: no code ran in the session that wrote this;
CI is the first run of every test named here.

## What changed

| File | Change |
| --- | --- |
| `pages/WorkspacePage.tsx` | No drawer: `/settings` and `/reports/upload` render in the main area. The chat stays mounted, hidden, off `/chat` |
| `pages/UploadReportPage.tsx` | Title and heading "Attach a report"; "Back to home" above it. The submit button keeps "Upload report" |
| `pages/SettingsPage.tsx` | "Back to home" above the heading |
| `pages/WorklistPage.tsx`, `pages/ReportsPage.tsx`, `components/reports/ReportRecordsTable.tsx` | Attach links to `/reports/upload`, named "Attach a report" and "Attach the first report" |
| `packages/help-content/src/help.ts`, `help.en.json`; `lib/helpSearch.ts` | Screen `upload` (`/reports/upload`); "attach-a-report" names the page and links to it; the four articles for every screen include it |

## Tests changed

| Test | Change |
| --- | --- |
| `pages/WorkspacePage.test.tsx` | Settings opens as a page with a level-one heading, no dialog and "Back to home", and Chat returns to the draft; new: Attach a report opens as a page. The preferred-name case returns by Chat instead of closing a drawer |
| `pages/WorklistPage.test.tsx` | The quick action's address is `/reports/upload` |
| `pages/ReportsPage.test.tsx` | "Attach a report" and "Attach the first report", for writers only, each to `/reports/upload` |
| `app/routes.test.tsx`, `e2e/upload.spec.ts`, `e2e/auth.spec.ts` | The upload page's heading is "Attach a report" |
| `lib/helpSearch.test.ts` | `/reports/upload` is the screen `upload` |
| `e2e/helpers.ts` | `openWorkspaceNavigation` no longer closes a drawer first |
| `e2e/upload-navigation.spec.ts` | Leaving the upload page is "Back to home" to the worklist, then Back; the recovery checks are unchanged |
| `e2e/landing.spec.ts` | A reader's "no access" on the upload page has no drawer to close |
| `product-demo-e2e/chat-upload.spec.ts` | "Settings opens as a panel" becomes "Settings opens as a page, and Chat returns to the same draft" |

Not changed: the header's "Upload report" link for the older signed-out layout (`SiteHeader.tsx:26`), whose absence tests stay as they
are; the local preview's own upload page (`LocalUploadReportPage.tsx`).

## Not done yet

- Breakages, one at a time, in a place where tests run (the open defect-injection list): an attach link pointed back at `/chat`; the
  upload page put back in a drawer; Settings put back in a drawer. Each must turn a named test red.
- RC1b, which removes the chat.
