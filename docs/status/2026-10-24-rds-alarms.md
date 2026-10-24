# The database instance has alarms (2026-10-24)

Date: 2026-10-24

**Implemented (no migration; Terraform text only).** Foundation layer 6 (cloud and compute). Nothing watched the RDS instance: the application and worker alarms read what they log, so a full disk, a pinned CPU or a connection limit reached would have shown only as errors elsewhere. `database-alarms.tf` adds three alarms on `aws_db_instance.main` into the audit topic: `database-low-storage` (free space under 4 GiB for three five-minute periods; no data counts as a breach), `database-cpu-high` (average over 80% for three periods) and `database-connections-high` (over 80 connections in one period). The RDS log groups are already managed (`database.tf`).

**The numbers are judgements.** Nothing has run against this instance. 4 GiB is a fifth of the default 20 GiB disk; the autoscaling ceiling (`db_max_allocated_storage`, 100 GiB) is separate. 80 connections is under the default limit of the smaller instance classes (roughly 100 on `db.t4g.micro` and 200 on `db.t4g.small` by the formula AWS documents for Aurora PostgreSQL, `DBInstanceClassMemory / 9531392`; the RDS PostgreSQL row was not read) and above what the pilot's task counts should open. The audit's open question, `SHOW max_connections`, is not answered by this change.

**Tests.** `database-alarms.guard.test.mjs` (imported by `guard.test.mjs`, so `pnpm test:infra` runs it) pins each alarm's namespace, metric, statistic, period, evaluation count, threshold, direction, silence handling, audit-topic action and instance dimension, as whole lines (a first draft matched substrings, so `threshold = 800` slipped past `threshold = 80`; the control caught it). Nine weakened-text controls cover them, plus a renamed instance and an empty read. `tofu fmt` is clean; CI's `terraform` job runs `validate`.

**Limits.** Not verified in AWS: the alarms firing, the metric dimensions matching, or the thresholds being sensible. Not covered: freeable memory, CPU credit balance on burstable classes, replica lag (no replica), and Performance Insights. No RDS event subscription (failover, maintenance) either. Those are separate decisions.
