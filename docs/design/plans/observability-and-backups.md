# Observability gaps and backup options

Status: **approved by the founder on 2026-11-11 with the recommended decisions** ("go with your recommendations"): OB1 Slack through
AWS Chatbot plus `ok_actions`; OB2 an unauthenticated canary first; OB3 our own client-error endpoint; OB5 7 days and the last 3
snapshots; OB6 AWS Backup with restore testing, after a read-only check that the SCP allows it; B1 to B4 option (a) each, as recommended in
[backup-scheduling-decisions.md](backup-scheduling-decisions.md). Still open, because each needs a value only the founder has: the budget
figure (OB4), the Slack workspace and channel (OB1), the two key custodians (B3) and the provider, after its answers to the seven
questions (B1). Written the same day, when the founder asked for a review of observability and for options for automating backups,
which are done by hand today. Writing it changed no code, Terraform, image, workflow or AWS, and nothing in AWS was read. Every claim below was read from `main` `5062c34` (file references given); what staging actually runs is
known only from [environments.md](../../ops/environments.md), last checked against AWS on 2026-11-08. **Before any slice here touches staging,
the founder runs `scripts/staging/staging-status.sh` and its table is quoted in that slice's plan.**

It complements [performance-measurement.md](performance-measurement.md) (latency) and builds on the open decision sheet
[backup-scheduling-decisions.md](backup-scheduling-decisions.md) (B1 to B4, waiting since 2026-10-19); it does not replace it.

## Part A: observability

### What exists

- **Logs.** API, worker, migration and provisioning tasks, both Lambdas, RDS (`postgresql`, `upgrade`) and CloudTrail, each with its own
  KMS key and 90 to 365 days of retention. All lines go through field allowlists (`apps/backend/src/logger-options.ts`,
  `packages/jobs/src/log.ts`), so values a user or patient supplied never reach a log. That design is a strength and every option below
  keeps it.
- **Alarms.** 36 in staging (environments.md), all built from AWS metrics or from log metric filters. No application code emits metrics.
  They cover the ledger (compromised, verification errors, stale checks), process faults, unhealthy or missing API tasks, 5xx/502/504, the
  worker (dead jobs, stuck queue and outbox, heartbeat, capability sweep), the database (storage, CPU, connections), the freshness check
  and eight audit events (deleted report objects, lock overrides, root use, trail and key changes).
- **Probes.** The load balancer checks `/api/v1/ready` (database, migrations, ledger) every 15 s; the freshness Lambda compares staging
  with `staging-expected.json` once a day.
- **Deliberately absent, and this plan keeps them absent:** load balancer, WAF and CloudFront access logs. They record full paths and query
  strings, which the API's own logger never records ([api-hosting.md](../../ops/api-hosting.md),
  [domains-and-hosting.md](../../ops/domains-and-hosting.md)).

### Gaps, most important first

| # | Gap | Evidence | Why it matters |
| --- | --- | --- | --- |
| O1 | **Every alarm reaches one email address, and nothing says when it clears** | One SNS topic, one email subscription (`audit.tf:452-460`); no `ok_actions` anywhere in Terraform | If that inbox is missed, nobody knows; and an alarm that fires and clears looks the same as one still firing. Fine for synthetic staging, not for production |
| O2 | **The frontend is invisible** | No error reporting, no `window.onerror`/`unhandledrejection` handler, no web vitals (`apps/frontend/src`); no CloudFront 5xx alarm; no external check of `app.staging` | A broken deploy, certificate or CloudFront change that leaves the API healthy raises no alarm. Users would be the monitor |
| O3 | **No outside check more often than once a day** | The freshness Lambda runs daily at 12:00 UTC (`freshness.tf:113`); no Synthetics canary or Route 53 health check | The 2026-11-08 outage (00:16 to 02:29 UTC) lasted over two hours. The internal alarms fire from inside AWS; nothing tests the path a user takes (DNS, CloudFront, sign-in, API) |
| O4 | **No latency alarm** | No alarm on the load balancer's `TargetResponseTime`; no latency metric from the request log lines | Slowness short of a 5xx is silent. Thresholds should come from the targets in performance-measurement.md (its D6), not be guessed |
| O5 | **The burstable database is only half watched** | `db.t4g.micro`; alarms on storage, CPU and connections only (`database-alarms.tf`); no `CPUCreditBalance`, `FreeableMemory` or read/write latency alarm; Enhanced Monitoring and Performance Insights off | When a burstable instance runs out of credits it slows to its baseline. CPU % can look moderate while queries crawl |
| O6 | **No request id from the user's screen to the logs** | The API returns `X-Request-Id` and puts `requestId` in every error body (`request-id.middleware.ts`), but the frontend neither shows it nor sends one; the worker's `job-started`/`job-finished` lines carry neither a request id nor a duration | When a user reports "it failed", there is nothing to search for. A job's run time cannot be read from the logs |
| O7 | **No cost alarm** | No `aws_budgets` or cost anomaly monitor | A runaway task, log volume or snapshot growth is found on the bill |
| O8 | **Some pieces have no failure alarm** | Password-notifier Lambda has no `Errors` alarm (`lambda.tf`); no API or worker CPU/memory alarm (autoscaling exists only when max tasks > desired, not in staging); WAF blocks counted but not alarmed | Each is small; together they are the long tail |
| O9 | **Account-level security services unknown** | GuardDuty and Security Hub: the organization's SCP denies even reading them (environments.md); Cognito has no threat-protection settings | Unknown, not off. Needs the organization owner, not this repository |
| O10 | **No single place to look** | No `aws_cloudwatch_dashboard` | During an incident, the founder has to assemble the picture from separate consoles |

### Options

| Slice | What | Kind | Cost and risk |
| --- | --- | --- | --- |
| A1 (O1) | Add `ok_actions` to every alarm; add a second notification path: a second email, or SNS to Slack through AWS Chatbot, or to PagerDuty | Terraform | Chatbot is free and AWS-side; PagerDuty is a new vendor (and a BAA question before alarm text could ever carry anything sensitive; today it never does) |
| A2 (O3, O2) | One CloudWatch Synthetics canary every 5 minutes: load `app.staging`, check `/api/v1/ready` through CloudFront, alarm on two failures | Terraform + a small canary script | A few dollars a month at a 5-minute rate (price it in the calculator first). It must use no real account; a signed-in journey needs a synthetic test user, decided separately |
| A3 (O5, O4, O8) | Add alarms: database `CPUCreditBalance`, `FreeableMemory`, `ReadLatency`; load balancer `TargetResponseTime` p95 (threshold from performance-measurement D6); CloudFront 5xx rate; password-notifier `Errors`; API and worker memory | Terraform | Each new alarm changes the expected alarm count the freshness check compares (`staging-expected.json`), in the same PR |
| A4 (O6) | Frontend shows the `requestId` from an error body ("reference: …") and sends `X-Request-Id`; worker adds `requestId` and `durationMs` to job lines (both are ids or counts, allowed by the logging rule) | Code, small | Needs the allowlist change in `packages/jobs/src/log.ts` and its log-shape test |
| A5 (O2) | Frontend error reporting. Options: (a) CloudWatch RUM, AWS-side; (b) a vendor such as Sentry; (c) a tiny `/api/v1/client-errors` endpoint that logs an error class and the route template only | Code + Terraform | (c) keeps the logging rule with no new vendor and is the recommendation. (a) and (b) collect URLs and browser data by default and would need scrubbing and, for (b), a BAA |
| A6 (O7) | AWS Budgets: a monthly budget with alerts at 50/80/100 % to the alarm topic | Terraform | Budgets are free at this scale |
| A7 (O10) | One CloudWatch dashboard for staging: API (requests, 5xx, latency, tasks), worker (queue age, heartbeat), database (CPU, credits, memory, connections), canary | Terraform | Free for the first few dashboards |
| A8 (O9) | Ask the organization owner whether GuardDuty and Security Hub are on for this account, and record the answer | A question | None |

**Recommendation:** A1, A6 and A8 first (cheap, and they make every other alarm count). Then A2 and A3. A4 next. A5 and A7 once the
others exist. A latency threshold in A3 waits for performance-measurement slice 5.

## Part B: backups

### What is done today, and by whom

| What | How | Evidence |
| --- | --- | --- |
| RDS automated backups | Automatic, kept **1 day** in staging (`profile.tf:41`); production would keep at least 7 (precondition, `database.tf:131`) | environments.md |
| Snapshot before each migration | `scripts/staging/release/migrate.sh` creates `telesphoros-staging-pre-<commit>` and waits for it; the founder runs the release. **Never deleted:** six exist so far | `migrate.sh:85-91`; environments.md |
| Terraform state | A versioned S3 bucket, plus a founder-run encrypted disk image (`state-backup.sh`), then a copy to Drive **by hand** | `state-backup.sh:2-11`; [staging-release.md](../../ops/staging-release.md) |
| Logical backup (`db:backup`) | Built: encrypted, signed, uploads to any S3-compatible bucket with Object Lock. **Never run against AWS; nothing schedules it**; the API image has no `pg_dump` | [backup-and-restore.md](../../ops/backup-and-restore.md); [offsite-backups.md](../../ops/offsite-backups.md) |
| Report files and audit log | Versioned, Object Lock; no replication | `storage.tf`, `audit.tf` |

### Gaps

| # | Gap |
| --- | --- |
| B-G1 | **No restore of the real database has ever been done.** Neither an RDS point-in-time restore nor a snapshot restore; the logical restore was drilled only locally (2026-10-07, 2026-10-10). A backup that has never been restored is a hope, not a backup |
| B-G2 | Staging keeps automated backups for 1 day: a mistake noticed on day 2 can only go back to the last pre-migration snapshot |
| B-G3 | No copy outside the AWS account and Region. The founder's 2026-10-08 requirement ("ideally another provider") is unmet; B1 to B4 are still open |
| B-G4 | No alarm when a backup fails or stops; nobody would notice a missing one |
| B-G5 | Pre-migration snapshots accumulate with no retention rule |
| B-G6 | Staging's data KMS key has a 7-day deletion window, and snapshots and backups depend on it; the logical backup key's two offline custodians are not named yet |
| B-G7 | Terraform state recovery has never been drilled ([environments.md](../../ops/environments.md), runbooks table) |
| B-G8 | Small mismatch: the CLI's default Object Lock is 30 days GOVERNANCE (offsite-backups.md); Terraform's `backup_lock_days` default is 14 |

### Options

**Option 1: AWS Backup for the database (new; not in the earlier sheet).** A backup plan in `us-east-2` with daily RDS backups and
continuous backup (point-in-time, up to 35 days), a vault with Vault Lock, EventBridge rules that send failed jobs to the alarm topic, and
**AWS Backup restore testing**, which restores a recovery point on a schedule, lets a validation step run, and deletes the copy. This replaces
"we hope it restores" with a monthly restore, and it needs no new image or credentials. Its limits: same vendor, account and Region, so
it does **not** meet the founder's other-provider requirement on its own (it is the floor, as B4 (a) describes); and it needs checking
against the organization's SCP, which has already refused KMS in other Regions (it may be fine in `us-east-2`; unknown). AWS Backup is a
HIPAA-eligible AWS service as far as I know; confirm against AWS's current list before real data.

**Option 2: the existing design, B1 to B4 in [backup-scheduling-decisions.md](backup-scheduling-decisions.md).** A dedicated backup image,
run as a scheduled ECS task, writing `db:backup` output to a non-AWS S3-compatible provider with Object Lock, keys held by two offline
custodians, with a `backup-check --max-age-hours 26` freshness alarm. This is what meets the other-provider requirement. It is blocked on
the founder's four decisions and the provider's BAA answers (Backblaze B2 and Wasabi were asked, STATUS.md). The first drill can use
synthetic data and needs no BAA.

**Option 3: the smallest changes, without either of the above.**
- Staging `db_backup_retention` from 1 to 7 days (a one-line Terraform change and an `INFRA` apply). RDS backup storage up to the database's
  size costs nothing extra, as far as I know.
- Keep the last N pre-migration snapshots, delete older ones in `migrate.sh` (N decided by the founder).
- A founder-run, scripted RDS point-in-time restore drill on staging: restore to a new `db.t4g.micro`, run the repository's own restore
  checks (row counts, schema, owners, RLS, ledger chain) against it, delete it. Roughly an hour of a micro instance.

These options do not exclude each other. **Recommendation:**

1. **Now:** Option 3's first two items, and the first point-in-time restore drill on staging (closes B-G1 and B-G2 at very low cost).
2. **Decide B1 to B4.** They have waited since 2026-10-19 and they are the real blocker for an off-site copy (B-G3, B-G6).
3. **Then choose the floor:** AWS Backup with restore testing (Option 1), or plain RDS automated backups plus the drill from step 1
   repeated monthly by hand. Option 1 is the one that keeps happening when nobody remembers.
4. **Then build Option 2** as planned in the sheet, with its freshness alarm (B-G4).
5. Terraform state: one recovery drill from the versioned bucket into a scratch directory (B-G7). The Drive copy stays manual until B3's
   custodians are named; it is not worth automating before that.

## Decisions only the founder can make

| | Decision | Recommendation |
| --- | --- | --- |
| OB1 | Where alarms go besides one email (A1) | Slack through AWS Chatbot, plus `ok_actions` |
| OB2 | A canary, and whether it signs in (A2) | Yes, unauthenticated first; a signed-in journey later with a synthetic test user |
| OB3 | Frontend error reporting (A5) | (c), our own endpoint, logging an error class and route template only |
| OB4 | A monthly budget figure (A6) | The founder's number |
| OB5 | Staging backup retention, and how many pre-migration snapshots to keep | 7 days; the last 3 snapshots |
| OB6 | AWS Backup with restore testing as the floor (Option 1) | Yes, after a read-only check that the SCP allows it |
| B1 to B4 | Off-site copy, job host, key custodians, profile | As in the sheet; unchanged here |

## What this plan does not touch

No code, Terraform, image, workflow or AWS change. No new log field, no access logs, no vendor chosen. Nothing about clinical holds, the
BAA (still not executed) or real data. The one edit outside this document corrects a row in environments.md, below.

## Corrections made in this pull request

- [environments.md](../../ops/environments.md), Report files row: production was described as "Object Lock COMPLIANCE (`profile.tf`
  precondition)". The code keeps report files on GOVERNANCE with a six-year minimum (`storage.tf`, `variables.tf`
  `reports_lock_days` ≥ 2190, founder decision 2026-10-19); the COMPLIANCE precondition applies to the audit bucket only (`profile.tf`).

## How each slice will be verified

Each slice is its own plan and draft PR. Terraform slices: `terraform fmt`, `validate`, `test`, the guard tests (`pnpm test:infra`), and
the freshness expectation updated in the same PR; after the founder's apply, each new alarm is fired once on purpose and must arrive, as
was done for the freshness alarms (T017). Code slices: the three backend tiers and the log-shape tests. Backup slices: the restore must
pass every check in backup-and-restore.md, the ledger chain included, and each new guard must be shown to go red when broken.
