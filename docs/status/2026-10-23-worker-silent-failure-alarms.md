# Alarms for silent worker failures (2026-10-23)

Date: 2026-10-23

**Implemented (Terraform written, never applied).** Three alarms in `worker.tf`, into the audit topic, with no migration:

- `worker-dead-waiting`: the `queue-stats` line already carries the number of dead jobs; the alarm fires while it is above zero. A job that dies from an expired lease on its last attempt is decided inside SQL (`job_claim`), so no worker logs it and `worker-job-dead` never saw it. The worker cannot count it directly: the job tables have forced row-level security keyed to a tenant the worker never binds, so a plain count returns zero without an error. Only `job_stats()` is cross-tenant.
- `worker-relay-failing` and `worker-schedule-failing`: the tickers already log `outbox-relay-failed` and `schedule-failed` and retry. Each alarm needs a failure in each of three consecutive one-minute periods (one to three minutes of continuous failure, about two typically), independent of the tick cadence. A minute without a failure publishes no data point and counts as healthy.

**Tests and controls.** The worker's own `Ticker` produces the failure lines and the contract test checks which filter each one matches and that healthy ticks and the other ticker match neither; the numeric `dead` field; `main.ts` still names the tickers as the test does. `worker.guard.test.mjs` pins the patterns, metric values, periods and `treat_missing_data`, with seven new weakened-text controls and four worker-side ones. Five defects injected into the contract tests were all caught.

**Not established.** The patterns are evaluated by the repo's small stand-in for CloudWatch's syntax, not by CloudWatch. Terraform is not installed here, so `terraform fmt`/`validate` and `profiles.tftest.hcl` (extended to count the new alarms) are unrun until CI. Nothing observed in AWS. Not covered: a relay that stops running without logging a failure (there is no outbox-age metric; that needs a migration), and telling a lease-expired dead job from any other (also a migration).
