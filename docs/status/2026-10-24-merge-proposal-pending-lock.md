# Two proposals for the same pair can no longer both go in (2026-10-24)

Date: 2026-10-24

**Implemented (no migration).** From the production-readiness audit (item 14, Low; item 10 asked for an index to go with it). `insertMergeProposal` refused a second undecided proposal for the same tenant, kind, source and target with a read ("is one pending?") followed by an insert, in one READ COMMITTED transaction. The ledger lock that serialises writers is taken only by the last statement, so two proposers could both read "nothing pending" and both insert; the pair then had two undecided proposals. **Reproduced** with a test-only trigger that sleeps inside the insert: both calls succeeded on the old code.

**The fix.** The transaction first takes `pg_advisory_xact_lock` on a key made of the tenant, kind, source and target, held to commit. The second proposer waits, then its pending check sees the first one's committed proposal and answers `proposal-pending` as before. A different target (or kind, or source) has a different key and is not held up.

**Why not the unique constraint the audit suggested.** "Open" means "has no row in `patient_merge_decisions`", which is another table, so no unique index can say it. A database guarantee would be a deferred constraint trigger on the existing proposals table; the migration lint treats a trigger on an existing table as `breaking` (an outage window), which is out of proportion to the harm: a second undecided proposal is clutter, not a wrong merge. The merge itself is still guaranteed by the decision-time rule (`patient_merge_decisions_graph`, at commit under the ledger lock), which refuses an approval whose source is already merged. No index was added either: the pending check uses the existing `(tenant_id, source_patient_id, seq)` index.

**Tests, red first.** `merge-proposal-race.pg-spec.ts` (real PostgreSQL, synthetic sleeping trigger): two proposers at once for one pair: one proposal is stored and the other is refused `proposal-pending` (two stored on the old code); different targets at once both go in and overlap (not queued); a proposal after the first has committed is still refused (controls). Two deliberate breakages, no lock and a lock too coarse to tell pairs apart, each turn a test red.

**Limits.** The guarantee is in the application path (the only writer of proposals); a direct insert by a database role with the right grants would bypass it. The application role is the only role that can insert.
