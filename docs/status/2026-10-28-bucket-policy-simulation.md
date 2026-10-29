# Verified: the reports and backups bucket policies under the IAM policy simulator

Date: 2026-10-28

Closes the "how AWS evaluates the policy" gap left by `2026-10-27-backup-upload-policy.md` and `2026-10-28-reports-managed-key-deny.md` (audit I1, I2, I3).

- The policies were rendered from `storage.tf` and `iam.tf` by the pinned Terraform and provider, with no AWS call, and evaluated with `aws iam simulate-custom-policy`, read only, in a founder-approved account. Nothing was created in AWS.
- 23 of 23 cases matched the expectation written before the run: each wrong encryption header is denied by the statement meant for it, including `aws:kms` with no key id (I3), on both buckets; the right key and a header-less upload are allowed; the backup job may `PutObject` and `PutObjectRetention` (I2) and nothing more. With `DenyManagedKey` removed, the I3 case came back allowed.
- Found: a key given as a bare key id rather than its full ARN is refused, and the runbook does not say which form `BACKUP_S3_KMS_KEY_ID` takes. Harmless while it stays unset, as documented.
- Not proven: which key S3 itself applies by default (a non-production `PutObject` would show it); the access-logs and audit buckets.

Record: `docs/verification/bucket-policy-simulation.md`.
