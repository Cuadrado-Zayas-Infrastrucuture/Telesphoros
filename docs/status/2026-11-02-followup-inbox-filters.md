# Filter the clinic follow-up list
Date: 2026-11-02

The existing chat-side Follow-ups panel now offers All clinicians / Assigned to me and All open / Overdue / Due today / Upcoming / Needs reassignment. Server-side filtering happens before pagination and uses the authenticated actor and each reminder's recorded timezone. Clinic counts and the recorded-response chart remain clinic-wide and are labeled accordingly.

Changing a filter resets to page one and hides the previous selection while loading. Obsolete responses cannot replace the current list; retry retains the selection. Empty filtered results offer Clear filters, and each reminder retains direct entry to the patient record. Patient/history queries, writes, ledger/schema, notification channels and secondary-use eligibility are unchanged.

This continues the approved physician-convenience direction. AI generated the change and tests. [Plan](../design/plans/followup-inbox-filters.md) and [verification](../verification/followup-inbox-filters.md). Local synthetic work only; no publication or deployment.
