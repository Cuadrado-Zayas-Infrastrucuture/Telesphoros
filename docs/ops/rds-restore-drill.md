# RDS point-in-time restore drill (staging, synthetic)

Founder-run, by hand, read and write: it creates one database instance and deletes it again. Nothing here has been run yet; the first
run records its date and result at the end of this page and in the runbooks table of [environments.md](environments.md). Decided by the
founder on 2026-11-11 (`docs/design/plans/observability-and-backups.md`, Option 3, in pull request #368). Synthetic data only: the
AWS BAA is not executed.

## What it proves, and what it does not

**Proves:** that RDS can restore the staging database to a chosen point in time; how long that takes (the first measured restore time);
that the copy keeps the source's encryption key, engine version and network; and that cleaning it up leaves nothing behind.

**Does not prove yet:** that the restored *content* is right (row counts, schema, owners, row-level security, the ledger chain). The
repository's `restore` command checks all of that ([backup-and-restore.md](backup-and-restore.md)), but it needs a PostgreSQL 16 client
in AWS, inside the database's network. No task has one today: the API image has no `pg_dump`, and the migration and provisioning tasks are
wired to the main database. That arrives with the backup image (decision B2 (a), [backup-scheduling-decisions.md](../design/plans/backup-scheduling-decisions.md));
once it exists, step 5 below gains the content checks and this page says so.

## Before

1. `scripts/staging/staging-status.sh`, and take the claim (`claim.sh take NAME "restore drill"`), so no release runs at the same time.
2. Confirm the identity: `aws sts get-caller-identity --query Arn`.
3. Cost: one `db.t4g.micro` for about an hour, plus its storage while it exists. Check the RDS pricing page for `us-east-2` first.

## Steps

All commands use `--region us-east-2`; `SRC=telesphoros-staging` and `DRILL=telesphoros-staging-drill-$(date -u +%Y%m%d)`.

1. Read what the copy must match, and the latest point it can restore to:

   ```bash
   aws rds describe-db-instances --db-instance-identifier "$SRC" --query 'DBInstances[0].[LatestRestorableTime,EngineVersion,KmsKeyId,DBSubnetGroup.DBSubnetGroupName,join(`,`,VpcSecurityGroups[].VpcSecurityGroupId),DBParameterGroups[0].DBParameterGroupName,BackupRetentionPeriod]' --output text
   ```

   Choose a restore time between the earliest point (now minus the retention: 1 day, the most AWS's free plan allows) and
   `LatestRestorableTime`. A time before the last migration is the more useful test, and must restore to that schema.
2. Start the restore, private and small, into the same subnet group, security group and parameter group (values from step 1). Note the
   start time:

   ```bash
   aws rds restore-db-instance-to-point-in-time --source-db-instance-identifier "$SRC" --target-db-instance-identifier "$DRILL" \
     --restore-time <ISO-8601 time> --db-instance-class db.t4g.micro --no-multi-az --no-publicly-accessible \
     --db-subnet-group-name <subnet group> --vpc-security-group-ids <security group> --db-parameter-group-name <parameter group> \
     --no-deletion-protection --tags Key=purpose,Value=restore-drill
   ```

3. Wait for it, and note the end time: `aws rds wait db-instance-available --db-instance-identifier "$DRILL"`.
4. Read the copy back with the same query as step 1, on `$DRILL`. It must show the same `EngineVersion`, the same `KmsKeyId`, the same
   subnet group, security group and parameter group, and status `available`.
5. Content checks: **not available yet** (above). Until then, record "content not checked".
6. Delete it, with no final snapshot and no retained backups, and wait:

   ```bash
   aws rds delete-db-instance --db-instance-identifier "$DRILL" --skip-final-snapshot --delete-automated-backups
   aws rds wait db-instance-deleted --db-instance-identifier "$DRILL"
   ```

7. Confirm nothing is left: `aws rds describe-db-instances --query 'DBInstances[].DBInstanceIdentifier'` lists only `$SRC`, and
   `aws rds describe-db-snapshots --db-instance-identifier "$DRILL"` lists nothing. Release the claim.

## Recording the result

Add a line here and update the `backup-and-restore.md` row in the runbooks table of environments.md: the date, the restore time chosen, the
start-to-available minutes (the measured restore time), whether step 4 matched, and "content not checked" until step 5 exists. A step
that fails is recorded as it happened, with the error class, not retried until it passes.

| Date | Restored to | Minutes to available | Step 4 | Content |
| --- | --- | --- | --- | --- |
| (not run yet) | | | | |
