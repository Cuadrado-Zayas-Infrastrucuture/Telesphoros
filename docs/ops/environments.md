# Environments: what is applied, and where

This page is the one place that says what exists outside a developer's machine. Read it before any page that says "never applied" or "nothing
is deployed". Dated records (`docs/status/`, `docs/verification/`, `docs/design/plans/`, `CHANGELOG.md`, the dated sections of
[STATUS.md](../STATUS.md)) keep the wording of their own date and are not rewritten.

**Last checked against AWS: 2026-10-31**, read-only, by the commands at the end of this page. A pull request that changes what is applied
updates this page in the same pull request.

| Environment | Exists | Data | Where |
| --- | --- | --- | --- |
| Local | On a developer's machine | Synthetic fixtures | "Running things locally" in [STATUS.md](../STATUS.md); [local-storage-operations.md](local-storage-operations.md) |
| Staging (synthetic) | **Yes**, since 2026-10-30 | Synthetic only. The AWS BAA is not executed, so no real patient data may enter it | AWS `us-east-2`; `app.staging.telesphoros.app` |
| Production | **No** | None | Nothing applied. The first-apply gates are in `infrastructure/terraform/README.md` and [deployment.md](deployment.md) |

## Staging (synthetic)

Applied by hand from the founder's backend clone, as the staged plans in [staging-plan-review.md](staging-plan-review.md) (stage A on
2026-10-29; stages B and C and the SES sender change by 2026-10-30). Later releases onto the running stack: `main` `f03b56e2` on 2026-10-30
(glibc/dpkg pins, the ledger heartbeat #195, the patient-identity KMS policy #198, migrations 0061 to 0063), and on 2026-10-31 the
CloudFront `/assets/*` cache (#202, #212), then `main` `6c4714de` (patient demographics, spec 025 PD-a, migration 0064; the same apply removed
the issuer's three log alarms, #210), then `main` `299efbb3` the same evening (spec 026: the worker removes expired capabilities every minute,
#214, migration 0065) and #216's three sweep alarms. No CI job holds cloud credentials or applies anything.

The last apply read the backend clone at, and so applied from `main` `780b88e3` (#216, the sweep alarms): anything merged after it under `infrastructure/terraform/` is not
applied until a release says so here. The values in the table below are kept as data in
[staging-expected.json](staging-expected.json) (spec 027); a guard in `pnpm test:ci-config` fails when this page and that file disagree, so change
both in the same pull request.

| Piece | What runs (read 2026-10-31) | What production adds or changes |
| --- | --- | --- |
| API | ECS Fargate service `telesphoros-staging-api` on cluster `telesphoros-staging-api`: 1 task, task definition revision 5, image `sha256:e1ea8d63e95f…` (commit `299efbb3`, pushed by hand; see "Break-glass" in [ci-cd.md](ci-cd.md)), `NODE_ENV=production`. Patient name and date of birth are encrypted under a KMS data key per patient; the task's key policy only allows calls with a `{tenant, patient}` encryption context | At least 2 tasks; only images signed in CI |
| Worker | Service `telesphoros-staging-worker`, 1 task (task definition revision 4), the same image. It runs the upload sweep and stale-file checks, and since 2026-10-31 removes expired tenant capabilities every minute (its first run removed the 73 that had accumulated; [jobs.md](jobs.md)) | |
| Issuer | **No service runs.** Its roles exist; its log alarms were removed on 2026-10-31 (#210), since only the issuer's own logs could raise them. Tenant binding is still `dual` (the database accepts the tenant the API sets) | The issuer service, and capability-only binding before real data |
| Lab-report pipeline and queued evaluation | **Off.** `NODE_ENV=production` refuses `LAB_REPORT_PIPELINE` and `EVALUATION_REQUESTS` (`apps/backend/src/config/env.ts`), so those routes answer 503 | |
| Frontend | S3 and CloudFront for `app.staging`, `www.staging` and `staging.telesphoros.app`. `index.html` was last published 2026-10-30 12:14 UTC ([frontend-publish.md](frontend-publish.md)). The hashed build output (`/assets/*`) is cached and compressed at the edge (managed CachingOptimized policy). The production build accepts structured JSON reports only | |
| Database | RDS PostgreSQL 16.13, `db.t4g.micro`, one Availability Zone, automated backups kept 1 day. Migrated through 0065; manual snapshots `telesphoros-staging-pre-6c4714de` and `telesphoros-staging-pre-299efbb3` were taken before 0064 and 0065 | Multi-AZ, deletion protection, at least 7 days of backups, a copy in a second Region (`database.tf` preconditions) |
| Sign-in | Cognito user pool `telesphoros-staging` (invite only, authenticator-app MFA required); mail through SES | |
| Report files | Versioned S3 bucket with Object Lock in **GOVERNANCE** mode, 1-day default retention, no replication | Object Lock **COMPLIANCE** (`profile.tf` precondition) |
| Audit trail | CloudTrail `telesphoros-staging-audit`, logging, **single Region**. It records every object read and write in the reports bucket, and deletes and lock changes in the audit bucket. The audit bucket has Object Lock in GOVERNANCE mode with 1-day retention ([audit-trail.md](audit-trail.md)) | A multi-Region trail and COMPLIANCE lock |
| Alarms | 34 CloudWatch alarms into SNS topic `telesphoros-staging-audit-alarms`, which has **1 confirmed email subscription**. Includes `ledger-compromised` ([ledger-watch.md](ledger-watch.md)), the audit alarms, the database alarms and the worker alarms. The three capability-sweep alarms (failing, stale, behind; #216) were applied on 2026-10-31 once the sweep ran, and each was fired once on purpose that evening: CloudWatch ran every notification and all three returned to OK. No other alarm has been fired on purpose yet | Paging to an on-call person |
| Terraform state | Versioned S3 state bucket in `us-east-2` ([terraform-state.md](terraform-state.md)) | |

**Not created, or not readable from the account.**
- **Not created:** the break-glass role ([break-glass.md](break-glass.md)), the image-signing key and the CI release role ([image-push.md](image-push.md)).
- **Blocks signing:** the organization's service control policy denies GitHub OIDC providers, so CI cannot sign images in this account.
- **Unknown:** GuardDuty, Security Hub and the cross-Region backup copy. The organization's service control policy denies even reading them
  from this account, so their state is unknown, not "off".

## Runbooks: last run against a real environment

| Runbook | Last real run | Note |
| --- | --- | --- |
| [staging-plan-review.md](staging-plan-review.md) | Staging, 2026-10-29 to 2026-10-30 | Stages A to C and the SES change |
| [staging-rehearsal.md](staging-rehearsal.md) | Staging, 2026-10-30 | Logins, schema and the first organization exist |
| [frontend-publish.md](frontend-publish.md) | Staging, 2026-10-30 | |
| [image-push.md](image-push.md) | Never through CI | Three images pushed by hand, the latest on 2026-10-31 (see above) |
| [backup-and-restore.md](backup-and-restore.md) | Logical restore drilled locally (2026-10-07) | RDS point-in-time restore never drilled |
| [offsite-backups.md](offsite-backups.md) | Emulator only | |
| [break-glass.md](break-glass.md) | Never | The role does not exist |
| [ledger-watch.md](ledger-watch.md) | Alarm exists in staging | Never fired on purpose |
| [terraform-state.md](terraform-state.md) | Bootstrap applied (the bucket exists) | State recovery never drilled |

## Checking it again (read-only)

**Before planning anything against staging**, run `scripts/staging/staging-status.sh` (founder-run, read-only; spec 027). It compares
live staging with `docs/ops/staging-expected.json` on `origin/main`, runs `terraform plan -lock=false -detailed-exitcode` on the backend
clone, lists the Terraform merged after the applied commit, marks saved plans made at another state serial as stale, and shows who holds
the stack claim. It prints identifiers and counts, never a state, plan or variable value, and exits 0 only when there is nothing to do.
A plan for staging quotes its table; a session that has not seen it does not know what staging runs. Its live values (the account, the
clone, the Terraform binary and data directory, the canonical var file) come from the private `~/telesphoros-private/staging/stack.env`,
described in the script's header.

The single commands below are what it runs, for reading one thing by hand. Run these with the staging identity, and confirm that identity first. The reports and audit bucket names end in the account id, so read them
from the console or `aws s3api list-buckets`; they are not written here.

```bash
aws sts get-caller-identity --query Arn
```

```bash
aws ecs describe-services --region us-east-2 --cluster telesphoros-staging-api --services telesphoros-staging-api telesphoros-staging-worker --query 'services[].[serviceName,desiredCount,runningCount,taskDefinition]'
```

```bash
aws rds describe-db-instances --region us-east-2 --db-instance-identifier telesphoros-staging --query 'DBInstances[].[DBInstanceClass,EngineVersion,MultiAZ,BackupRetentionPeriod]'
```

```bash
aws cloudwatch describe-alarms --region us-east-2 --alarm-name-prefix telesphoros-staging --query 'length(MetricAlarms)'
```

```bash
aws cloudtrail get-trail-status --region us-east-2 --name telesphoros-staging-audit --query IsLogging
```

A read the organization's policy refuses is reported as unknown here, never as absent.
