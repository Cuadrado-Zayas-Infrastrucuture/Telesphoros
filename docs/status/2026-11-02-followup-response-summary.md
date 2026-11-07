# Physician visibility into recorded treatment responses
Date: 2026-11-02

The chat-side Follow-ups panel now has a collapsible Recorded treatment responses summary. Five labeled horizontal bars show improved, unchanged, worsened, response not assessed and no assessment recorded, with visible counts and the complete follow-up denominator. The reminder list stays primary. Empty or failed reads show explicit states; invalid totals are refused and can be retried independently of the list.

`GET /api/v1/followups/summary` reads the caller's clinic through the existing application-role tenant boundary. The versioned definition `followup-response-v1` counts each treatment-follow-up thread once, across all pages and including closed reminders. Its most recent document/amend assessment determines the response even after reschedule/dismiss events. Deleted patients are excluded. Clinicians/reviewers can read it; no patient identifiers or notes are returned. No migration or chart dependency was added.

This is physician-facing documentation visibility, not treatment-effect evidence or a secondary-use release. The denominator contains recorded follow-up threads, not all clinic patients or validated treatment episodes. Data Insights still needs defined cohorts/endpoints, reproducible projections, operational use grants and controlled releases. [Plan](../design/plans/followup-response-summary.md), [metric definition](../design/followup-response-summary.md), [verification](../verification/followup-response-summary.md).
