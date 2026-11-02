# Physician follow-up response summary
Date: 2026-11-02

Continue the founder's approved chat/patient workflow and physician visibility direction. Add a read-only summary inside the existing Follow-ups panel, behind a compact disclosure so the actionable due list stays primary. No new page, migration, external provider, dependency or publication.

## Meaning and boundaries

Use the existing persisted treatment-follow-up history across the caller's clinic. The unit is one follow-up thread, not one patient, drug exposure or validated endpoint. Count all threads belonging to non-deleted patients, including closed reminders. For each thread select the latest document/amend assessment by version, even if a later reschedule/dismiss has no assessment. Corrections replace that thread's category; retries and previous assessments do not add counts. Report improved, unchanged, worsened, response not assessed, and no assessment recorded as separate categories. Show the complete denominator, the count with a response documented, and an explicit all-time scope/as-of timestamp. A patient can have several follow-ups. Do not infer effectiveness, adherence, completion rate or cause from these categories.

Version the definition as `followup-response-v1` in the shared API contract. Aggregate with one database statement under the normal tenant-bound application role, including explicit tenant filters. Return counts only, without labels, IDs or notes. Restrict reads to clinicians/reviewers. Keep unknown query parameters invalid. Memory storage reports unavailable. This is an in-clinic documentation summary; secondary-use eligibility and Data Insights release remain separate. Patient merges and condition-specific instruments must be handled before using this as a patient-level research projection.

## UI and verification

Use five labeled horizontal bars with visible counts and a shared total scale, rendered with small native SVG marks inside an accessible table. No hover-only data, animation, clinical scores or new chart dependency. Use existing neutral tokens; an empty clinic shows an empty state, and failed/malformed responses show retry rather than zeros. Fetch only when the disclosure opens, refresh after save/on focus/visible timer, and abort on close. Failures must not block the reminder list or saving follow-ups.

First reproduce the missing summary API with real PostgreSQL HTTP tests. Prove all five categories, corrections, rescheduling after documentation, explicit closure, idempotency, totals beyond 20 rows, tenant/role boundaries and deleted-patient exclusion. Prove the latest-assessment selection guard by temporarily removing its ordering/selection and observing a failing test. Browser-check real storage at mobile/desktop widths, visible denominator/categories, empty and retry states, keyboard access and Axe. Run required workspace checks, report existing failures/skips, inspect screenshots and tear down exact owned synthetic resources.
