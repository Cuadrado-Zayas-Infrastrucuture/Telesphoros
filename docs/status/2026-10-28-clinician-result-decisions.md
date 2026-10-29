# Spec 006 D01b: clinician result decisions (local, vocabulary held)

Date: 2026-10-28

**What it adds.**
- A clinician can record what they decided about one evaluation result, and anyone who reads clinical records can read the result's whole history.
- An entry is one of three kinds:
  - a decision (accepted, modified, rejected, deferred, or clarification requested, with codes saying what changed and why);
  - an amendment of how that decision was documented;
  - a withdrawal of an entry made in error.
- Routes: `POST` and `GET /api/v1/evaluation-results/:id/clinician-decisions`. Migration 0055. Design: section 24 of `docs/design/records-and-corrections.md`.

**What it guarantees, and where.**
- **One exact result.** Composite keys make a wrong-chart row impossible.
- **Who may write.** Only a current clinician, by the live membership row: checked by the route and again by the database.
- **Amendments and withdrawals.** Only the entry's author.
- **One history per result.** A result's history is a single line; two writers on one head cannot both commit.
- **Retries.** They return the original, even after a retraction.
- **Eligibility.** A decision is refused when the result is not on its report's current, undisputed evaluation, or is held. This is read after the ledger lock, so a retraction or dispute committed first is always seen.
- **Time.** The recorded time is the database's clock. A reported clinical time is kept beside it and can never make a late entry look timely.

**What it does not do.**
- No entry says that a recommendation was presented, ordered, dispensed or taken.
- Nobody can enter a decision on someone else's behalf.
- No frontend, export or analysis.

**Before it can ship.**
- **D6:** decided on 2026-10-28 (13 codes). Nothing left here.
- **Migration number:** H4 slice 2 (#120) merged first as 0054, so this is 0055.
- **Rebase:** onto `main` after #119, then the full loop again.

Evidence: `docs/verification/clinician-result-decisions.md`.
