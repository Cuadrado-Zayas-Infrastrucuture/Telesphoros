# Staging keeps 7 days of backups and 3 pre-migration snapshots

Date: 2026-11-11

The founder's decision OB5 (`docs/design/plans/observability-and-backups.md`, pull request #368, 2026-11-11), written and tested,
**not applied**.

- **Retention.** The synthetic profile keeps RDS automated backups for 7 days instead of 1 (`profile.tf`). Production is unchanged: at least
  7, default 14. It takes effect at the next `INFRA` apply, which the founder runs; until then staging keeps 1 day and
  [environments.md](../ops/environments.md) says so. RDS applies a change between two non-zero retention periods with no outage.
- **Snapshots.** `scripts/staging/release/prune-snapshots.sh` keeps the newest 3 snapshots named `<db>-pre-<commit8>` and deletes older ones.
  It is a dry run without `--yes`, never lists automated backups or other manual snapshots, and deletes nothing while one of them is still
  being created. `migrate.sh` runs it last, after the migration and its new snapshot; a failure there is a warning, not a stopped release.
  Staging holds six such snapshots today, so the next release that migrates (a seventh) deletes the oldest four.
- **Drill.** [rds-restore-drill.md](../ops/rds-restore-drill.md) is the founder-run point-in-time restore drill. It proves the restore and
  measures its time; checking the restored content needs the backup image (B2) and says so. Not run yet.

Proved: the release tests run the real scripts against stand-ins (10 of 10, three new). Four mutants each turn them red: keeping 2, a looser
name match, no dry run, and a prune failure that stops the release. The infrastructure guards (463 of 463) pass. **Not run locally:**
`terraform fmt`, `validate` and `test` (no Terraform binary in the session that wrote this); CI's `terraform` job runs them.
