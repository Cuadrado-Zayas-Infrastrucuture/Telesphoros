# Spec 019 D02a: result acknowledgements (local)

Date: 2026-10-29

**What it adds.**
- A clinician can record that they reviewed one evaluation result, and anyone who reads clinical records can see who reviewed it, when, and whether that review covers the result as it stands now.
- An acknowledgement is a `review`, or, on a retracted result, `retraction-reviewed`.
- Routes: `POST` and `GET /api/v1/evaluation-results/:id/acknowledgements`. Migration 0060. Design: section 25 of `docs/design/records-and-corrections.md`.
- A `ReviewedControl` component, shown on a test-only page in the e2e build. The clinical result view is a separate build and adopts it.

**What it guarantees, and where.**
- **One exact result.** Composite keys make a wrong-chart row impossible.
- **Who may write.** Only a current clinician, by the live membership row: checked by the route and again by the database.
- **The basis shown.** A review is refused when the result's basis changed after it was shown. This is read after the ledger lock, so a retraction or dispute committed first is always seen.
- **Once.** One acknowledgement per clinician, result, review task and kind. Retries return the original.
- **No false success.** The control says "Reviewed" only after the server stores it.

**What it does not do.**
- No acknowledgement says that anything was read, ordered, dispensed or taken.
- No render capture (D02b), no clinical result view, no care-relationship rule (P6 waits for a care-team model).

Evidence: `docs/verification/result-acknowledgements.md`.
