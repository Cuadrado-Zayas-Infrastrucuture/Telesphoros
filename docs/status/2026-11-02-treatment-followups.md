# Treatment-linked follow-up documentation and in-app reminders
Date: 2026-11-02

The patient record now supports scheduling, documenting, correcting, rescheduling and dismissing follow-ups linked to an exact recorded medication version. Documentation captures response, adverse symptoms, assessment source, optional adherence detail and a short note. Saving the assessment also saves the physician's explicit next-date choice and responsible clinician, or closes the reminder. The chat sidebar opens a clinic follow-up panel with overdue/today/upcoming counts and reassignment warnings; opening a patient keeps the chat draft.

Migration 0067 adds tenant-scoped, append-only, ledgered history. Original deadlines survive changes; retries do not duplicate records; stale edits are refused. Notes use existing redactable storage. Assessment and reminder timezones are stored independently. Reads derive due state from database time and the latest version, so no external notification job is created. `FOLLOWUP_WRITES` defaults to disabled and the API always refuses writes in production; the owned synthetic demo explicitly enables it.

This supersedes the storage/UI implementation gap in the earlier [reminder requirements entry](2026-11-02-follow-up-reminders-plan.md). Optional AI note drafting, external notifications, recommendation-decision controls on the patient page, condition-specific outcome instruments and Data Insights projections/releases remain future work. The API accepts an explicit same-patient decision reference; the form does not create or infer one. Existing migrations 0062/0063 provide provenance and synthetic eligibility foundations; this change does not authorize secondary use or add follow-up records to eligible fact kinds.

[Plan](../design/plans/treatment-followups.md) and [verification](../verification/treatment-followups.md). Synthetic local implementation only; no deployment or clinical release.
