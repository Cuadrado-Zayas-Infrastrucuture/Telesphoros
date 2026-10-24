# Missing foreign-key indexes: declined, with a guard (2026-10-24)

Date: 2026-10-24

**No migration.** The production audit (item 13) listed five foreign keys with no index on their referencing columns (`report_patient_decisions.identifier_id`, `capture_acceptances.note_id`, `corrections.note_id`, `cell_dispute_decisions.evidence_note_id`, `evaluations.capture_acceptance_id`) and recommended indexes. Re-read on `main` 528b158, the premise does not hold here, so the indexes were **not** added.

**Why.** An unindexed foreign key costs a scan of the child table only when a parent row is deleted or its key changes. Probed on a migrated database, all thirty-three unindexed keys have a parent the application role cannot `DELETE` from (`has_table_privilege('telesphoros_app', parent, 'DELETE')` is false for each); the parents of the five in question are `event_notes`, `capture_acceptances` and `patient_identifiers`, which also refuse deletes by trigger. The code that reads these columns joins from the child to the parent by the parent's primary key (`projections.ts` lines 57 to 87, `ledger-records.repository.ts:399`), which the parent's own index serves. So an index would add write cost to append-only ledger tables and be read by nothing. The audit's claim was reasoned from the schema, not from a query plan.

**What was added.** `test/db/fk-indexes.pg-spec.ts` pins the condition that makes this safe: a foreign key may go without a covering index only while the application role cannot delete from its parent. It passes today (no violations) and has a control that creates an unindexed key on a parent the role may delete from, sees it reported, then indexes it and sees it cleared. `docs/database.md` has a short section "Foreign keys and their indexes".

**Limits.** Not covered: a hard delete by the owner role in a maintenance session would scan the child tables of whatever it deletes. Query plans at 10^5 to 10^6 rows were not run (the audit's separate point about plan-shape assertions is unchanged and still open).
