# The patient page when the identity cannot be read: the plan

Date: 2026-11-24

A plan, `docs/design/plans/patient-page-identity-outage.md`. Today, if a patient's demographics read fails for a reason that will pass, the
whole patient page is replaced by one error line, hiding the genomic profile and medications. That happens with a 503 when the KMS key
cannot be opened, and on the in-memory store. The plan keeps the rest of the page and puts a warning, naming the label, in the banner's
place. Four decisions are put to the founder:

- B-D1, which failures stay page-level;
- B-D2, the wording;
- B-D3, what renders and what waits: the recommendation holds every write until the identity is read;
- B-D4, a clinical-validation note.

Not approved yet. No code, setting or check change.
