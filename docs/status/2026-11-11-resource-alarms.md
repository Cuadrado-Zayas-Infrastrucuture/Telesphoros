# Alarms on database credits, memory and latency, service CPU and memory, and notifier failures

Date: 2026-11-11

Slice A3 of the observability plan (`docs/design/plans/observability-and-backups.md`, approved 2026-11-11). Written and tested, **not applied**.

`infrastructure/terraform/resource-alarms.tf` adds alarms on what nothing watched yet, each into the audit topic with a recovery notice:

| Alarm | Fires when |
| --- | --- |
| `database-cpu-credits-low` (burstable classes only) | CPU credit balance under 20 for 15 minutes |
| `database-memory-low` | freeable memory under 128 MiB for 15 minutes |
| `database-read-latency-high` | reads averaging over 100 ms for 15 minutes |
| `api-cpu-high`, `api-memory-high`, `worker-cpu-high`, `worker-memory-high` | a service averaging over 90% of its reserved CPU or memory for 15 minutes |
| `password-notifier-errors` | the password-change notifier Lambda fails at all |

The thresholds are judgements, not measurements. **Not included:** a CloudFront 5xx alarm, because CloudFront's metrics exist only in
`us-east-1` and the project stays in one Region.

When applied, staging gains 8 alarms (36 to 44). The freshness check compares the live count with `alarms` in `docs/ops/staging-expected.json`,
so the release that applies this updates that figure and `docs/ops/environments.md` together, or the next daily check reports a finding.

`infrastructure/terraform/resource-alarms.guard.test.mjs` checks each alarm's metric, comparison, threshold, recovery notice and missing-data
rule, and six broken copies each turn it red. The profile guard now lists the credit alarm's read of `db_instance_class` as a known, read-only
use. `pnpm test:infra` 466/466. `terraform fmt` and `validate` were not run locally (no Terraform binary in this session); CI's `terraform` job
runs them.
