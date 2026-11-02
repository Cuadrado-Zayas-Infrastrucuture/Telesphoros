# Treatment-linked follow-up documentation and in-app reminders

Date: 2026-11-02. Implementation detail under the founder's approved physician-workspace direction and explicit “continue”. Preserve the existing local UI work. No publication or deployment is included.

## Scope and model

Add migration 0067 with a down migration and a ledgered `patient_followups` history. A thread links one patient to an exact recorded medication version. It is a documentation/reminder thread, not proof of dispensing, ingestion or a complete treatment episode. Do not invent exact treatment dates from the medication's month fields. An explicit optional clinician-decision reference must belong to this same patient; no decision is inferred from a note.

Each append records one action: schedule, document, amend, reschedule or dismiss. The latest version determines the next due task; previous versions retain original deadlines, assignment, observations and authorship. Saving an assessment and its next task is one row/transaction, so partial saves cannot lose a reminder. Idempotent requests return their original result; concurrent writes require the version the physician saw. Notes use the existing redactable `event_notes` storage and only note references/digests enter ledger payloads. Clinical-read access to notes is limited to clinicians/reviewers, matching existing note access. A current clinician may document or manage a task; only the author may amend an assessment.

Assessment fields: actual assessment date with its own timezone (including when no next task is needed), source (clinician or patient reported), treatment response (improved/unchanged/worsened/not assessed), adverse symptoms (reported/none reported/not assessed), adherence (reported taking/reported not taking/not assessed), short note. These are documentation categories, not validated endpoints or automatic causal conclusions. No numeric efficacy score, diagnosis, treatment recommendation or generated observation. New condition-specific instruments remain a later clinical-definition task.

The physician explicitly chooses a next local calendar date and named active clinician, or no further follow-up. Store an IANA timezone with each date; show the timezone. Scheduling can begin before the first assessment. Reschedule and dismiss require a reason. A departed/suspended assignee remains in history and the task appears as needing reassignment. Corrections preserve scheduling state; a new clinical assessment can close the current task and open the next. Closed threads remain available in history.

## Reminder delivery and UI

The first delivery is the persistent in-app due list, derived from stored tasks and database time, with due-today/overdue/upcoming/unassigned state. This does not need a queue job or an external notification: no job can fire an obsolete deadline because each read uses the latest committed version. Refresh on save, window focus and a bounded timer while the view is visible. Failure shows a retry state, never a fabricated zero count. Email/push and background delivery are separate later integrations.

Patient record: compact Follow-up section, schedule/document actions, treatment selection, explicit next-date choice, recent threads and expandable history. Chat sidebar: Follow-ups button/counts opens a panel, and each task links to the patient form without clearing the chat draft. Keep existing tokens, 44px targets, keyboard access, compact mobile layout and no new clinical page.

Backend: shared strict contracts; PostgreSQL repository, controller/service/module; forced tenant RLS, ledger registration/verifier projection; same-patient medication/decision references; actor/assignee membership and retry/concurrency checks. Non-PostgreSQL storage reports unavailable. A default-off write setting and production refusal retain synthetic-only rollout. Do not alter eligibility policy to approve these records for secondary use: unknown fact kinds remain ineligible until a reviewed extension.

## Verification

First prove missing API behavior with failing HTTP tests against the existing real PostgreSQL harness. Then prove atomic document/next-task save, same-request replay, changed-request conflict, stale concurrent updates, amendment attribution, cross-patient references, tenant isolation, role refusal, inactive assignment, date/timezone boundaries, overdue persistence, reschedule/dismiss and ledger verification. Prove the key guard by removing it and observing a failing test. Down migration refuses populated histories. Preserve schema/role/ledger inventories with assertions for the new record.

Browser-check actual storage at mobile/desktop: schedule, document, retained next task after reload, history, failed-save draft retention and chat-panel navigation. Run typecheck, lint/format, relevant tests, build, infrastructure and CI checks; report skipped or blocked checks. No inference provider, real data, analytics export, source-license change or live release.
