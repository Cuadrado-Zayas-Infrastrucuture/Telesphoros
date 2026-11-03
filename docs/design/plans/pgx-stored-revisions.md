# Stored synthetic report revisions and finding rows (032 S2b2)

Date: 2026-11-02
Status: Authorized by the founder's “continue” after the remaining-work summary. Build from merged main; carry the synthetic-only scope forward.

## Complete path

In the existing owned-local report panel, save the laboratory evidence after its patient link has been independently verified. Re-read and hash the pinned source using `StructuredPreviewService`; the client supplies only the exact expected source/patient/reference/decision binding, never findings or approval flags. Record one immutable source-backed revision and ledger event per internal upload. Concurrent/repeated saves return the same stored identity. A different upload remains a distinct provenance reference, even for identical bytes.

Migration 0068 adds `structured_report_revisions` and a security-invoker, read-only `structured_report_findings` view. The revision stores the strict laboratory report (including assay manifest, original findings, uncertainty and limitations), source hash/version, internal patient, independent patient-link decision and parser contract version. Finding rows expose stable `(revision_id, source_finding_id)` references and typed state columns from that one immutable record; there is no second mutable copy to drift from the ledger. Extend the existing ledger event inventory, projection and deferred row/event checks without changing old hashes. Coordinate verifier rollout; down refuses populated new records.

Tenant RLS, append-only mutation/truncate guards, exact source binding, live/unmerged patient and current patient-link checks apply at the database boundary. Use the existing transaction/ledger authority check. Serialize registry inserts, inspect all stored sources for the patient (maximum 100, never silently truncated), and refuse cross-patient reuse of the same issuer/series, accession or report identity. Same-patient conflicting revisions remain preserved and held. Snapshot reads use one consistent transaction snapshot and conservatively hold if a stored source or patient-link decision is no longer current; do not omit it and revive an older source.

Lineage is recomputed from the complete stored set with the merged inspector; no clinical/current-profile acceptance is persisted. Adapt its tenant validation to the application's canonical tenant schema (tenant IDs are not necessarily UUIDs), keeping strict mismatch refusal. Display stored/not-stored, the complete-chain candidate or explicit holds, and original history in the existing disclosure. A saved source is evidence for review, not a prescribing assessment or analytic acceptance. Uncertain/absent findings are never filled from older reports.

## Boundaries

Owned disposable loopback PostgreSQL/S3 only, clinical processing disabled. No inference, actual CPIC content, vendor PDF reader, issuer authentication, analytic approval, assessment generation, amended-assessment task scheduling, secondary-use export or deployment. Existing clinical, data-rights and real-data gates stay closed. Future assessments must recheck the complete current basis in their committing transaction; this read model does not authorize release.

## Verification

Start with API acceptance against actual PostgreSQL/Moto and a missing endpoint; preserve all existing preview and patient-link controls. Exercise stored rows/view/ledger, replay/concurrent save, wrong scope/role/binding, stale or revoked review, deleted/merged patient/source, conflicting/amended/duplicate source histories, cross-patient identity collision, append rollback and corruption detection. Verify RLS and direct SQL append-only/event guards, reversible empty migration and refused populated down. Use independent expectations and targeted guard-removal controls. Run all three backend service profiles and F2/F3 recovery validators, required workspace checks, and an actual mobile/desktop upload → independent review → save → reopen browser path. Report skipped engine suites and hosted acceptance separately.

## Implementation decisions

The stored finding view exposes the original finding/assay JSON alongside typed coverage, analytical state, interpretation state and call columns. Its security-invoker setting applies the revision table's tenant RLS to every row. The client receives only compact revision history and source finding IDs, never an imported assessment. It sends the expected source/patient/review binding; the server re-reads the pinned bytes and derives all stored evidence.

Patient matching is distinct from findings acceptance. A completed matching form collapses and the physician can save evidence in the same report panel. Saving does not produce prescribing guidance. Lost write replies clear local state and require a fresh read; server replay is idempotent. Changing a stored source or review holds the patient history, including evidence that could otherwise be omitted to revive an earlier candidate. Reconciliation/analytical review remains a future operation; the prototype does not silently repair a held series.
