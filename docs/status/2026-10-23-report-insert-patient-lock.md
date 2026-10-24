# A report can no longer be registered on a patient that is being deleted (2026-10-23)

Date: 2026-10-23

**Implemented.** From the production-readiness audit (item 1, High, first recorded as reasoned, now reproduced). `ReportsService.create` reads the patient in one transaction and the repository inserts the report in another. The patient's soft-delete trigger (`block_patient_soft_delete`, migration 0001) asks "are there live reports?" under READ COMMITTED, so it cannot see a report that has not committed, and the report's foreign key takes only a KEY SHARE lock, which a soft delete (an update that does not touch the key) does not conflict with. Two interleavings left a live report on a deleted patient: a delete that committed while the registration was uncommitted, and a registration that committed after a delete. The new two-session test (`test/db/report-patient-delete-race.pg-spec.ts`, modelled on the merge race test) failed four of its five cases on the old code. `insert` and `insertOrReplay` now lock the patient row `FOR SHARE` in the same transaction and refuse a patient that is already gone (`IntegrityError`, which the API answers as 409). A delete that arrives later waits, then sees the committed report and is refused; a delete that committed earlier is seen and refuses the report.

**Limits.** The fix is in the repository, not the database: a different writer that inserts into `reports` directly still bypasses it (nothing else in `src` does). A merge approval racing a registration (a merged-away patient takes no new report) is not covered: both sides take compatible share locks, and the merge check is made only in the service. No migration.

**Not established.** Nothing observed in AWS. The in-memory repository has no concurrency and is unchanged.
