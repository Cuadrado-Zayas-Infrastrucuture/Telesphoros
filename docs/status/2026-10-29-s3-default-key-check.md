# Verified: which key S3 applies to a reports upload (audit I3, real S3)

Date: 2026-10-29

Closes the "which key S3 itself applies" gap left by `2026-10-28-bucket-policy-simulation.md` and `2026-10-28-reports-managed-key-deny.md`.

- Founder-approved throwaway resources in `us-east-2` (one customer-managed KMS key, a bucket per run), with the rendered reports bucket policy. All were removed afterwards; the key is pending deletion.
- An upload with no encryption header, as the application sends, gets the bucket's key. `aws:kms` without a key id gets the AWS-managed `aws/s3` key when no policy stops it, so I3 is real; the reports policy refuses it.
- Found: with `DenyManagedKey` removed, S3 still refused that upload (by elimination `DenyOtherKey`), where the simulator had allowed it. In S3 `DenyManagedKey` is a second barrier, not the only one.
- Not proven: the backups bucket in AWS.

Record: `docs/verification/s3-default-key-check.md`.
