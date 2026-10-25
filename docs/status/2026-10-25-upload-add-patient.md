# A clinician can add a synthetic patient from the upload page (2026-10-25)

Date: 2026-10-25

**Implemented (front-end only).** The upload page no longer ends in a dead end when the patient roster is empty. A clinician already had no screen to add a patient: the page said "Ask a clinician to add a synthetic patient", which a signed-in clinician could not act on without calling the API. Now:

- With an empty roster, an **Add a synthetic patient** form opens by itself, under the patient list. With patients, the same form is one click away (**Add a synthetic patient**, with **Cancel**).
- It takes one field, a synthetic label (letters, numbers and hyphens, up to 40 characters), checked by the existing shared rule before anything is sent. Names and real identifiers are refused by that rule, and the patient model holds no name or date of birth.
- **Add patient** (or Enter in the field) calls the existing `POST /api/v1/patients`, then selects the new patient and returns focus to the patient list. Enter does not submit the upload form.
- One request id is kept per label: a retry after a lost answer replays the same patient instead of creating a second; a different label gets a new id.
- Refusals are plain and show no server text: 409 label already exists, 403 role cannot add patients, 400/422 label not accepted, 429 too many requests, anything else a retry message. What was typed is kept, and nobody is selected.

**Not changed.** The backend, shared types, roles, tenant rules, the dev-only local upload pages, and every other upload behaviour. A patient is still only created by an explicit click, so the "no auto-create" assertion of the empty-roster test stands.

**Supersedes** the interim guidance in `docs/verification/patient-setup-guidance.md` (2026-10-14), which sent users to the API. `docs/ops/patient-setup.md` is updated; the older note stays as history. Patient search screens and a full onboarding workflow remain separate product work.

**Checks.** 13 new API tests and 8 new page tests (positive path, Enter, bad label, 409 and 403, lost-request retry, collapsed and cancelled form, axe). Three controls were broken on purpose and each made a test fail: Enter without its guard (the upload form's submit fired), a fresh request id on every retry, and a bad label sent to the server. One of them first survived because the input was disabled during the request, so the input is read-only instead and the guard is what is tested.
