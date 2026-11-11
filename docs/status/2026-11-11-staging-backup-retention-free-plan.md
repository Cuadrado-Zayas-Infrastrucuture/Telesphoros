# Staging keeps 1 day of backups: the AWS free plan refuses 7

Date: 2026-11-11

The `INFRA` apply of #368's 7-day retention, at `3ccc97d9`, was refused by AWS: `ModifyDBInstance` returned `FreeTierRestrictionError`,
"The specified backup retention period exceeds the maximum available to free tier customers". The account is on AWS's free plan. Nothing
changed: the database kept 1 day, and the IAM policy in the same plan was never updated (it waited on the database).

The plan and the release check could not see this: only AWS knows the account's plan, and it answers at apply.

Changed here:

- `profile.tf`: synthetic `db_backup_retention` back to 1, with the reason in the comment. The guard test and `profiles.tftest.hcl` say 1.
- The OB5 notes in [observability-and-backups.md](../design/plans/observability-and-backups.md), the
  [first status note](2026-11-11-staging-backup-retention.md) and [rds-restore-drill.md](../ops/rds-restore-drill.md) say 1 day and why.

Unchanged: the last 3 pre-migration snapshots (`prune-snapshots.sh`, `migrate.sh`) and the restore drill. Production's floor of 7 days is
unchanged too, so a production database in this account would need the account off the free plan first.

To get 7 days on staging later: move the account to the paid plan (the founder's decision, it changes billing), then set this back to 7 and
apply it as `INFRA`.
