# Verified: CloudTrail delivers under the audit bucket's write deny (audit I4, real AWS)

Date: 2026-10-29

Closes the "Not proven" paragraph of `2026-10-29-audit-bucket-write-deny.md`.

- Founder-approved throwaway KMS key, bucket and single-region trail in `us-east-2`, with the audit bucket policy rendered from `audit.tf` (`DenyWritesNotFromThisTrail` included). All removed afterwards; the key is pending deletion.
- The trail was created and delivered its first log file within 30 seconds, encrypted with the key, with no delivery error. The account's own full-access role was refused a write under `AWSLogs/`.
- Not verified: Object Lock, the CloudWatch Logs side, a multi-region trail, and the key policy exactly as rendered (it was a hand copy).

Record: `docs/verification/audit-trail-delivery.md`.
