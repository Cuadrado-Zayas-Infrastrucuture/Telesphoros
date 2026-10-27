# Fix: the backup job can upload to the off-site bucket, encrypted only with the backup key (local, not applied)

Date: 2026-10-27

Found by the 2026-10-27 audit (I1, I2, I3). The off-site backup resources are written but have never been applied, so nothing has failed in AWS. As written, every upload would have been refused on the first apply.

**I1: the bucket policy refused the uploader's default request.**
- `DenyUnencryptedUploads` refused every PutObject whose encryption header was not `aws:kms`, and that includes a request with no header at all.
- The uploader sends no header by default (`BACKUP_S3_SSE` defaults to none).
- The fix uses the reports-bucket pattern instead. Each deny applies only when the header is present and wrong (`Null = false`). The bucket default, the backup key, encrypts a header-less upload.

**I2: the backup role could not set retention.**
- Every upload sets Object Lock retention, which S3 authorizes as `s3:PutObjectRetention` on top of `s3:PutObject`.
- `backup_job` now holds both. It still cannot bypass a lock, read, list or delete.

**I3: naming `aws:kms` without a key id is now refused.**
- Without a key id, S3 uses the AWS-managed key, not the bucket default.
- `DenyOtherKey` pins any named key to the backup key, and SSE-C is refused, as on the reports bucket.
- `docs/ops/offsite-backups.md` documents `BACKUP_S3_KMS_KEY_ID`.

**Tests.** `guard.test.mjs` gains `backupUploadProblems` and seven weakened-text controls.
- On the old text it reported all three problems (red); on the new text it is clean.
- `pnpm test:infra`: 148 of 148.

**What the guard cannot prove.** The guard reads Terraform text; it does not prove how AWS evaluates the policy. The IAM policy simulator, or a PutObject against a non-production locked bucket, is still to be done with founder approval.

**Not covered.** The reports bucket has the same `aws:kms`-without-key-id gap. That needs a separate change.
