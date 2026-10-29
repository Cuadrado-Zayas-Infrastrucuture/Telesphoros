# Fix: the reports bucket refuses aws:kms named without a key id (local, not applied)

Date: 2026-10-28

Found by the 2026-10-27 audit (I3). The backups half was fixed on 2026-10-27 (`2026-10-27-backup-upload-policy.md`), which named this half as not covered.

**The problem.** The reports bucket policy refused any encryption but `aws:kms`, any named key but the data key, and customer-supplied keys. An upload that named `aws:kms` with no key id was not refused, and S3 encrypts such an object with the AWS-managed `aws/s3` key, not the data key. Nothing has been applied in AWS, and the data is synthetic.

**The fix.**
- `DenyManagedKey` (`infrastructure/terraform/storage.tf`) refuses a PutObject whose encryption header is `aws:kms` and that has no key id. It is the same statement as on the backups bucket.
- The application uploads reports with no encryption header (`s3-object-storage.ts`), so the bucket default applies and none of its uploads is refused. The evidence store always sends a key id with `aws:kms` (`evidence-catalogue.ts`).

**Not changed.** The backups, access-logs, web and audit buckets, the KMS keys, and the application. The audit bucket has no encryption denies; only CloudTrail writes to it, under its own key. Reviewing that is a separate item.

**The tests** (`infrastructure/terraform/guard.test.mjs`, `pnpm test:infra`, 150 of 150 on `main` `b1b8b1d`):
- `reportsLockProblems` now requires `DenyManagedKey`. It reported the missing statement on the old text, and a new control (its `StringEquals` weakened) must be reported.
- Changing the statement's `Null` condition to `false` by hand turned the guard red; the file was restored.
- The backups guard's own `DenyManagedKey` control replaced the first match in the file, which is now the reports statement, so it went red. It now targets the backups statement.

**What the guard cannot prove.** It reads Terraform text, not how AWS evaluates the policy. Terraform is not installed on the machine that made this change, so `terraform fmt` and `terraform validate` ran only in CI. The IAM policy simulator, or a PutObject against a non-production bucket, needs founder approval.
