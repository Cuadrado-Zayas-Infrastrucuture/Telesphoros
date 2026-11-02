# Focus the physician's follow-up list
Date: 2026-11-02

Continue the approved physician workflow: add compact assignment and due-status selectors inside the existing chat-side Follow-ups panel. Defaults remain all clinic reminders. Physicians can choose Assigned to me and all open, overdue, due today, upcoming or needs reassignment. No new page, notification channel, clinical inference or secondary-use release.

The inbox API applies both filters to current reminders before pagination, using the authenticated actor for “me” and each stored reminder's timezone for due status. Existing patient/history reads retain their contract. Clinic counts and the recorded-response chart remain explicitly clinic-wide; filtering never changes documentation or closes tasks. Strict query validation refuses unsupported values and combining history selection with inbox filters. No database migration is required.

Changing a selector resets to page one, clears the previous result while loading and aborts obsolete reads. Empty filtered results say no matching reminders and offer Clear filters; errors offer retry without losing the selectors. Keep accessible labels, 44px controls, mobile reflow, explicit dates and the direct-entry action. Filters remain local to the panel session.

First reproduce unsupported filtering through the real PostgreSQL HTTP harness. Verify selection before pagination, authenticated assignment, latest-version rescheduling/closure, removed-assignee handling, tenant/role isolation, timezone state and malformed queries. Prove assignment filtering with a mutation. Browser-check combined filters, pagination reset, empty/reset states, interrupted requests/retry and direct entry on desktop/mobile. Run required repository checks and record failures/skips. Preserve prior local work; no publication/deployment.
