# Two record-log events now have alarms (2026-10-24)

Date: 2026-10-24

**Implemented (no migration).** Foundation layer 12 (errors and logs). The record-log watch writes several lines, and only `ledger-compromised` had a metric filter. Two others say the log is not being checked and now have a filter and an alarm into the audit topic each (`api-compute.tf`): `ledger-verification-error` (the check could not run; one line in 15 minutes) and `ledger-chain-over-size` (a chain longer than one walk covers; one line in an hour). Silence is normal for both.

**The repeat decision.** The runbook held this back because "an alarm that fires on every pass needs a decision on how often to repeat". CloudWatch notifies on a state change, not per line, so a line that comes once a pass leaves the alarm in ALARM after one notification and returns to OK after a quiet hour. The default chosen: one notification per episode, a new one at the next pass after a quiet hour. A reminder rule is left to the founder.

**Deliberately not alarmed.** `ledger-verification-incomplete` is expected on every cold start (the first walk is still running), so it would fire on every deploy; a walk that never completes shows as one of the two alarmed lines. `ledger-incident-record-failed` is retried each minute, and its finding already raised `api-ledger-compromised`. Both reasons are in `docs/ops/ledger-watch.md`.

**Tests.** The API Terraform guard pins each filter's pattern and metric, each alarm's metric, period, threshold, silence handling and audit-topic action, and that `ledger-monitor.ts` still writes both events; five weakened-text and application-side controls (another event name, silence as failure, two lines needed, each event renamed in the application) each fail the guard. Nothing in the application changed.

**Limits.** Not verified in AWS: the filters matching real log lines and the alarms firing. The periods (15 minutes, one hour) are judgements, not measurements. The pass interval (24 hours by default, jittered) is read from `env.ts`; an environment that sets `LEDGER_FULL_VERIFY_INTERVAL_HOURS` differently changes how often over-size repeats.
