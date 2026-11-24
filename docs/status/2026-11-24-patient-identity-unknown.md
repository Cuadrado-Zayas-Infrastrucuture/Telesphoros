# The patient page when the identity cannot be read

Date: 2026-11-24

This builds the plan in `docs/design/plans/patient-page-identity-outage.md` (#453). The founder approved it on 2026-11-24, with B-D1 to
B-D4 as recommended.

Before, the whole patient page was replaced by one error line whenever its demographics could not be read now, hiding the genomic profile
and the medications. That happens with a 503 when the key cannot be opened, another 5xx, a 429, or a network failure. Now:

- The page stays up, and a warning in the banner's place names the label. Its Retry reads only the identity.
- The page never looks like "none recorded".
- Nothing that records something for the patient is offered until the identity is read: medications, results, decisions, follow-ups, and
  the profile's "Record a decision".
- A 403, a 404 for a patient who is not available, and a missing earlier version still replace the whole page.

A validation note is in `docs/clinical-validation/patient-identity-unknown.md`. A new browser test, `e2e/patient-identity-unknown.spec.ts`,
runs the state against the in-memory e2e API's own 503.

Frontend only: no backend, route, setting, check or migration change. Staging gets it with its next frontend release.
