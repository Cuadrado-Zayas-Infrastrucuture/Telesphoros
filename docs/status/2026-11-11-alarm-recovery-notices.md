# Every alarm also says when it clears

Date: 2026-11-11

Slice A1 of the observability plan (`docs/design/plans/observability-and-backups.md`, decision OB1, approved 2026-11-11), first half. Written and
tested, **not applied**.

Each of the 34 CloudWatch metric alarm resources in Terraform (the audit one makes eight alarms, one per audit event) now sends `ok_actions` to the same SNS topic as its `alarm_actions`, so the alarm email
subscriber gets a second message when an alarm returns to OK. Until now an alarm that fired and cleared looked the same as one still firing.
That covers the API, worker, database, audit, freshness, password-notifier and issuer alarms (the issuer's are not created in staging). No
threshold, period, metric or missing-data rule changed, and no alarm was added or removed, so the freshness check's expected alarm count (36 in
staging) is unchanged. It takes effect at the next `INFRA` apply.

`infrastructure/terraform/alarm-recovery.guard.test.mjs` reads every `aws_cloudwatch_metric_alarm` in the Terraform and fails when one notifies
nobody, or clears to different targets than it fires to (or to none). Its controls show each of those, and deleting the line from the real
`lambda.tf` turned it red, naming the alarm. The four guards that test exact alarm text had their deliberately broken snippets updated to
include the new line. `pnpm test:infra` 466/466. `terraform fmt` and `validate` were not run locally (no Terraform binary in this session); CI's
`terraform` job runs them.

The second half of A1, alarms to a Slack channel through AWS Chatbot, waits on the founder: it needs the Slack workspace and channel, and the
workspace has to be authorized in the AWS Chatbot console once.
