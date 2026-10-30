# Spec 019 D02b: result render capture (local)

Date: 2026-10-29

**What it adds.**
- A record that one result row's recommendation summary was on a clinical reader's screen, under the rule `render-v1`: at least half of the summary in view (`viewport`), or keyboard or assistive-technology focus inside it (`focus`), in a visible tab, for one continuous second.
- Each episode stores one `exposure` row, then `duration` rows with its continuous and cumulative visible time. No row is ever updated.
- Route: `POST /api/v1/result-renders`, a batch of at most 50 events. Migration 0061. The hook `useResultRender` and a summary region on the e2e test-only page. The clinical result view is a separate build and adopts the hook.

**What it guarantees, and where.**
- **Ids and times only.** The strict schema and the table have no field that can carry a drug, phenotype, recommendation text or patient label.
- **Who.** Only a current clinical reader (reader, clinician or reviewer), by the live membership row: checked by the route and again by the database, which copies the viewer's roles and membership version.
- **Tenancy.** A batch naming any result outside the caller's organization answers 404 and stores nothing.
- **Once.** A retried batch stores nothing twice; the answer counts what was stored before.
- **Append-only, not ledgered.** UPDATE, DELETE and TRUNCATE are refused; FORCE row-level security; no ledger event.
- **Lossy by design.** Retries are bounded and failures are never shown to the clinician. A duration whose exposure was lost is skipped and counted (`withoutExposure`), so it never takes other rows' events down with it.

**What it does not do.**
- A render is evidence of display, never of reading or understanding. A missing row means unknown.
- No retention period yet (set with counsel before real data), no coverage or lag reports, no clinical result view.

Evidence: `docs/verification/result-render-capture.md`.
