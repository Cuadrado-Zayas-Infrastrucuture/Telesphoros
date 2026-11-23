# Feature Specification: Notice when someone else closes your reminder (FN)

**Feature Branch**: `feat/followup-closure-notice`

**Created**: 2026-11-20

**Status**: Plan approved by the founder 2026-11-20 ("Approve plan"), after deciding who may close another clinician's reminder ("(a)
Anyone, with notice"). Slice P0-C of the 2026-11-16 clinical UX and adoption audit (finding H9: a teammate dismisses a reminder and the
action is never taken). Spec 044 is the release gate on another branch.

**Input**: Any active clinician of the organization can dismiss a reminder assigned to someone else (the `patient_followups_check` trigger of
migration 0067). Every dismiss already carries a note of 1 to 1,000 characters (`packages/shared-types/src/patient-followups.ts`), and a
reminder whose assignee left already reads "Needs reassignment" (`needs_reassignment`). What is missing: a dismissed reminder leaves the
assignee's inbox and nothing tells them, and nothing records that they saw it. Follow-up writes are off in every deployed environment
(`FOLLOWUP_WRITES` defaults to `disabled`, and no Terraform sets it).

## Decisions

- **D1, who may close (founder, 2026-11-20): anyone, with notice.** Dismissing stays open to every current clinician, with the note already
  required. The assignee is told, and the acknowledgement is recorded.
- **D2, the notice lasts until acknowledged.** No expiry and no escalation; escalating overdue items is a separate audit item.
- **D3, a separate read.** The notices come from their own route, so the inbox list and every other reader of it keep their shape.

## Requirements

| ID | Requirement |
| --- | --- |
| FN-1 | **A notice.** A dismiss version whose previous version's assignee is not the dismissing clinician is a closure by someone else. It shows to that assignee as a notice: the patient label, the medication, who closed it, when, and the closing note. |
| FN-2 | **Until acknowledged.** The notice shows until the assignee acknowledges it. `GET /api/v1/followups/closures` (`clinician`, `reviewer`, always on, reads only the caller's notices, newest first, at most 50, and the total). |
| FN-3 | **The acknowledgement is a record.** `POST /api/v1/followups/:id/acknowledge` (`:id` the thread; body: `requestId`, `followupId` of the dismiss version; `clinician`; behind `FOLLOWUP_WRITES` as every follow-up write). It stores one row in `patient_followup_closure_acks` (migration 0076): append-only, FORCE row-level security, one ledger event `patient-followup-closure-ack`. A repeated `requestId` returns the same acknowledgement. |
| FN-4 | **Only the assignee, once.** The database refuses an acknowledgement by anyone but the previous version's assignee, of a version that is not a dismiss, of a dismiss the acknowledger wrote, a second one for the same dismiss, one from another organization, and one from a person who is not a current clinician. |
| FN-5 | **On the page.** The Follow-ups page shows "Closed by someone else" above the list, in words: "Closed by NAME on DATE: NOTE", with an Acknowledge button each. No badge. |
| FN-6 | **Nothing else changes.** Who may dismiss, the note rule, `needs_reassignment` and `FOLLOWUP_WRITES` are unchanged. |

## Acceptance tests (synthetic data; real PostgreSQL through the application's own role)

| ID | Test | Must fail when |
| --- | --- | --- |
| T-1 | A colleague dismisses a reminder assigned to the clinician: the clinician's notices list it with the closer and the note; the colleague's do not | a closure by someone else is not shown, or is shown to the closer |
| T-2 | The assignee dismisses their own reminder: no notice | every dismiss becomes a notice |
| T-3 | Acknowledge: 201, the notice leaves the list, a `patient-followup-closure-ack` event is stored and the ledger verifies | the notice stays, or no ledger event is written |
| T-4 | A repeated `requestId` returns the same acknowledgement; a second acknowledgement with a new `requestId` is 409 | an acknowledgement is stored twice |
| T-5 | Refused by the database through the application role: by someone other than the assignee (403), of a version that is not a dismiss (400), of the clinician's own dismiss (400), from another organization (not visible), from a person who is not a clinician (403); UPDATE and DELETE refused | a non-assignee or a stranger can acknowledge, or a row can change |
| T-6 | With `FOLLOWUP_WRITES` off: acknowledge is 503 `followup-writes-paused`; notices stay readable | the switch is skipped |
| T-7 | Roles: `GET` for `clinician` and `reviewer`, `POST` for `clinician` only; the route list pins both | a role is widened |
| T-8 | The page shows the notice in words and acknowledging removes it; axe clean | the notice is colour-only or stays after acknowledging |
| T-9 | Migration 0076 down refuses while rows exist and reverses an empty table, restoring 0069's event-type set | the down drops records, or leaves the new type |

## Out of scope

- Escalation of overdue reminders, delivered and read states, email or push notices.
- Who may dismiss (D1 keeps it open), and reason categories for a dismiss.
