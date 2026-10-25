# Legacy recommendations table dropped, migration 0043 (2026-10-24)

Date: 2026-10-24

**Implemented.** Migration `0043_drop_recommendations` (label `breaking`) drops the `recommendations` table. Step one recreates the report soft-delete guard without its check on that table (the guard has named it since 0008); step two drops the table with its triggers, policy, indexes, constraints and grants. `set_updated_at()` and `forbid_identity_change()` stay, because patients and reports use them. The table was unused: the route went in #19, the repository, record type and DTOs in #39, and no deployed database was found to hold rows (nothing is applied in AWS; the only reachable account has no RDS database, cluster or snapshot).

**The drop refuses to run while the table holds a row.** The table is `FORCE ROW LEVEL SECURITY`, so its owner sees no rows through the policy; the migration lifts the force first (inside the same transaction) so the check can see them, and `telesphoros.allow_recommendations_drop=yes` allows the loss on purpose. The check is tested as a non-superuser owner, the production case; as a superuser it would pass whether or not the force were lifted.

**The `down` recreates the table, empty,** as it stood after 0013, with the policy bound through `app_tenant()` as 0032 left it (0032's own revert counts those policies) and owned by the owner of `reports`, so a later migration's role switch still works. Rows do not come back. After up then down, `pg_dump` of the table, its policy, privileges, triggers, columns and the guard function match the database before the drop.

**Tests.** New `drop-recommendations.pg-spec.ts` (empty drop, the row guard under a non-superuser owner, the up/down round trip, the soft-delete guard with and without an evaluation, which nothing tested after the table went). The specs and helpers that expected the table at the head of the history lose those parts (`schema-acceptance`, `rls`, `tenant-binding` now expects 47 `app_tenant()` policies, `migrations`, `backup-restore`, `recovery-seed`); `recommendation-integrity.pg-spec.ts` now replays only through 0013; `tenant-capability.pg-spec.ts` expects the table back when 0043 is reverted. `LEGACY_TABLES` loses the table.

**Not changed:** migrations 0001 to 0042 (checksums pinned), the evaluation and ledger tables, `docs/verification/*` (dated records), and the unique constraint `reports_tenant_patient_id_uq` that 0012 added for the dropped foreign key (still used by the report-patient decisions and upload attempts).

**Verified (local):** typecheck, lint, build, `test:infra`, `test:ci-config`, tiers 1 to 3 (2,678 / 2,680 / 2,700), fixture lifecycle (11), worker (234). Five deliberate breaks of the migration each failed the new spec or a neighbour: row guard removed, row-security lift removed, old guard function kept, down policy in the old form, down ownership step removed. Hosted CI has not run.
