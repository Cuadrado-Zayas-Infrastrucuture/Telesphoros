# The audit trail (CloudTrail, protected logs, alarms)

Step F1. **Written, never applied.** `infrastructure/terraform/audit.tf` describes it; nothing exists in AWS. It is part of the same root
module as the rest, so the three first-apply gates in `infrastructure/terraform/README.md` (executed BAA, remote state, a human reading the plan) apply to it too.

## What it does

CloudTrail records who did what in the AWS account. This trail keeps the record somewhere nobody can quietly rewrite, and raises an alarm on the few events that matter.

| Piece | Detail |
| --- | --- |
| **The trail** | Multi-region, includes global service events, **log file validation on** (CloudTrail writes signed digest files, so a changed or removed log can be detected). |
| **What is recorded** | Every management event (reads and writes); **every read and write of an object in the reports bucket**; and, in the audit and backup buckets, **every delete and every change to an object's lock** (`DeleteObject`, `DeleteObjects`, `PutObjectRetention`, `PutObjectLegalHold`). All S3 data events, through three advanced event selectors. The audit bucket records only deletes and lock changes because recording every write there would record the trail's own log deliveries, a loop AWS warns against. |
| **The log bucket** | Private, versioned, ACLs disabled, TLS 1.2+ only, **Object Lock**: `COMPLIANCE` in production, enforced by a precondition (founder decision 2026-10-19: nobody, not even root, can delete a log before its lock ends); `GOVERNANCE` / 1 day only in the synthetic rehearsal so it can be destroyed; lock days default 365, encrypted with a **dedicated KMS key**, kept for `audit_log_retention_days` (default and floor **2190**, six years). Only CloudTrail, for this trail and this account's prefix, may write. |
| **The key** | `aws_kms_key.audit`, rotation on. The application's policies have no access to it (a test enforces that), so a stolen application role can neither read nor alter the audit logs. |
| **A CloudWatch copy** | Only so metric filters can alarm (kept 365 days). The S3 bucket is the record. |
| **Alarms** | Eight, each firing on a single occurrence and emailing the SNS topic (encrypted with the audit key). `alarm_email` is a variable with no default; AWS emails it a confirmation link that the owner must click. |

## The alarms, and what to do

| Alarm | Fires when | What to do |
| --- | --- | --- |
| `ReportObjectDeleted` | A report file, or one of its versions, is deleted in the reports bucket, **or someone tried** (denied attempts are logged too). The application cannot delete report files. | Find who in the trail. If it is the break-glass role, find the decision record ([break-glass.md](break-glass.md)). If there is no record, treat it as an incident. |
| `EvidenceLogDeleted` | An audit log or an off-site backup is deleted, or someone tried. CloudTrail and the backup job never delete. | Treat as an incident: someone is erasing the record. In production the COMPLIANCE lock refuses the delete, but the attempt itself is the signal. |
| `ObjectLockOverridden` | The retention or legal hold of one object in the reports, audit or backup bucket changes. Shortening a GOVERNANCE lock needs the bypass right. | Expected only with a written break-glass decision ([break-glass.md](break-glass.md)); otherwise an incident. |
| `BreakGlassRoleAssumed` | The break-glass role is assumed, or someone tried. The role is not created yet; the name comes from `break_glass_role_name`. | The same: a written decision record must exist before the assumption. |
| `RootAccountUsed` | The AWS root user does anything. | It should never be used day to day. Find out why; rotate its credentials if you cannot explain it. |
| `AuditTrailChanged` | Someone stops, deletes or changes the trail or its event selectors. | Treat as an attempt to hide activity. Restore the trail first, then investigate. |
| `DataBucketProtectionChanged` | The policy, public-access block, ACL, versioning, Object Lock or lifecycle of the reports, audit or backup bucket changes. | Confirm it was a planned Terraform change; otherwise revert it and investigate. |
| `EncryptionKeyChanged` | A KMS key is disabled, has rotation turned off, has its policy replaced, or is scheduled for deletion. | Cancel a scheduled deletion at once (30-day window); investigate who. |

## After the first apply (checklist; none of this has been done)

1. Click the confirmation link in the SNS email. Until then no alarm reaches anyone.
2. Check the trail is logging: `aws cloudtrail get-trail-status --name <audit_trail_name output>` should show `IsLogging: true` and a recent `LatestDeliveryTime`.
3. **Test every alarm path once** by forcing the state (this proves the topic, the subscription and the key policy, not the filter pattern):
   `aws cloudwatch set-alarm-state --alarm-name <alarm name> --state-value ALARM --state-reason "test"`, then confirm the email arrived.
4. Test a **filter pattern** against a real event (for example delete a test object version in a test bucket's copy of the setup, or use the console's "test pattern" with a sample event). The patterns have **not** been run against real events yet.
5. Validate a day's logs: `aws cloudtrail validate-logs --trail-arn <trail arn> --start-time <UTC time>`; it should report every log and digest file valid.

## What it does not do

- **It is not instant.** CloudTrail delivers events some minutes after they happen, so an alarm lags the event.
- **It does not record who signs in to the application.** CloudTrail covers administrative calls to Cognito, not users signing in; sign-in logging is separate work. The application's own record log (the ledger) is separate too: see [ledger-watch.md](ledger-watch.md).
- **It does not record reads or ordinary writes in the audit and backup buckets**, only deletes and lock changes (above). Their settings changes are watched by `DataBucketProtectionChanged`.
- **The production audit lock is irreversible.** Once applied in COMPLIANCE mode, no one (not even root) can shorten it or delete a locked log, and the bucket cannot be emptied before the lock ends. That is the point; it is also why the synthetic profile refuses COMPLIANCE.
- **Report files are locked in GOVERNANCE mode** (six years, [storage.tf](../../infrastructure/terraform/storage.tf)): an identity with `s3:BypassGovernanceRetention` can still remove one, deliberately and visibly (`ReportObjectDeleted`, `ObjectLockOverridden`).
- **The `ledger-compromised` alarm is not here.** It lives with the application's log group in `api-compute.tf` (step F3b) and publishes to this topic, so one confirmed address hears everything ([api-hosting.md](api-hosting.md)).
- **Cost.** Management events for the first copy are free; S3 data events are billed per event, and a second management-event copy or a busy bucket changes that. With synthetic data and a small bucket the cost is negligible, but it grows with real use: check the current AWS CloudTrail pricing before applying.

## Verification status

Checked by `pnpm test:infra` (`audit.guard.test.mjs`: every rule is proved by breaking a copy of the text and watching it reported), `terraform fmt -check`, `terraform validate` and `terraform test` (`profiles.tftest.hcl`: production plans with COMPLIANCE, refuses GOVERNANCE in production, and uses three advanced selectors). **Not verified:** that AWS accepts the plan and the key and bucket policies together, that the metric-filter patterns match real events, delivery, the alarm emails, and the lock behaviour. Those need the first apply.
