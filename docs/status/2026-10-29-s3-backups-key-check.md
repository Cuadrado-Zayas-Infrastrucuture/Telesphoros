# Verified: which key S3 applies to a backups upload (audit I3, real S3)

Date: 2026-10-29

Follows `2026-10-29-s3-default-key-check.md`, which checked the reports bucket and left the backups bucket untested in AWS.

- Founder-approved throwaway KMS key and bucket in `us-east-2`, with the rendered backups bucket policy and no Object Lock (the policy needs no lock header). Both removed afterwards; the key is pending deletion.
- The same outcomes as the reports bucket: no header gets the bucket's key, `aws:kms` without a key id gets the AWS-managed `aws/s3` key when no policy stops it, and the policy refuses it, also without `DenyManagedKey`.
- Found: in `us-east-1`, the default `backup_region`, this account's role was refused `kms:CreateKey`, and a service control policy denies `kms:ListKeys`. A first apply with that default may fail on the backups key; unproven. `docs/ops/offsite-backups.md` now says to check it before the first apply.

Record: `docs/verification/s3-default-key-check.md#backups-bucket`.
