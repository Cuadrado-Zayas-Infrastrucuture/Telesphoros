# Feature Specification: Follow-up forms say when recording is paused (FAV)

**Feature Branch**: `fix/followup-availability`

**Created**: 2026-11-10

**Status**: Plan approved by the founder 2026-11-10 ("Yes, keep boundaries"), after a clinician walkthrough of a build equivalent to staging. Numbered 037 because 035 (follow-up documentation) and 036 (agent job runner) are taken on unmerged branches.

**Input**: On staging a clinician can open "Document follow-up" or "Schedule follow-up", fill the form and press save, and only then read "Follow-up recording is unavailable. Your draft is kept; retry later." Retrying never helps: the API refuses every follow-up write unless `FOLLOWUP_WRITES` is `enabled` and the process is not in production mode (`patient-followups.module.ts`), and staging runs in production mode. That refusal is deliberate ("A default-off write setting and production refusal retain synthetic-only rollout", `docs/design/plans/treatment-followups.md`).

## Decisions

- **D1, the refusal stays (founder, 2026-11-10):** this change does not enable follow-up recording anywhere and does not touch the production refusal or any deployment setting. It changes only what the clinician is offered and told.
- **D2, the API says whether recording is on:** `GET /api/v1/followups/availability`, for the roles that read follow-ups (clinician, reviewer), answers `{ "recording": "enabled" | "paused" }`. It reads one method, `recordingEnabled()`, which the write also uses, so the read and the refusal cannot disagree. It reveals nothing about a patient or a member.
- **D3, a new read, not a new field:** the plan first said to add a field to `GET /followups/assignees`. That response is parsed with a strict schema, and the API and the front end are released separately, so a new field would make an already-released front end reject the answer. A separate read is safe in either release order: an older front end never calls it, and a newer front end treats an API without it (404, or any body it does not recognize) as "unknown".
- **D4, unknown is not paused:** when the answer cannot be had, the page behaves exactly as before this change. Only an explicit `paused` hides anything.
- **D5, what a paused page shows:** on the patient record, the Follow-up section keeps its list, counts, History and Refresh, and for a clinician shows "Follow-up recording is not available in this environment. Follow-ups already recorded stay readable." in place of every way into a form: Document follow-up, Schedule follow-up, and each entry's Document, Reschedule, Dismiss and Correct assessment. A link that asks for a form (`?followup=…`, or a decision's "schedule follow-up") lands on that same list.
- **D6, the refused save names its reason:** the 503 from a paused write carries `reason: "followup-writes-paused"` (the medication fence's pattern). The front end then says recording is not available here and that the draft is kept, without "retry later". Any other 503 keeps the retry wording.

## Out of scope

Enabling follow-up recording on staging or in production; the Follow-ups panel in the sidebar (its links land on the paused list, D5); the medication fence; clinician display names and the patient banner (separate changes from the same walkthrough).
