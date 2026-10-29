# Verification: the reports and backups bucket policies, and the backup job's policy, under the IAM policy simulator

Date: 2026-10-28

Scope: the encryption and transport denies on the reports and backups buckets (`infrastructure/terraform/storage.tf`), and the backup job's upload policy (`iam.tf`), for audit items I1, I2 and I3. Until now they were checked only by the text guards (`guard.test.mjs`), which read Terraform and cannot say how AWS evaluates a policy. Nothing was applied, created or changed in AWS. `storage.tf` and `iam.tf` are unchanged between `fefcb31`, where they were rendered, and `main` `711c818`.

## Method

- **The real JSON, not a hand copy.** The three `aws_iam_policy_document` blocks were copied out of `storage.tf` (`reports_bucket`, `backups_bucket`) and `iam.tf` (`backup_job`) by line range into a scratch module. Only the four references were replaced, by AWS documentation example ARNs (account `111122223333`); the replacement counts were asserted (8, 7, 1, 2) and no other reference remained. Terraform 1.16.5 (the CI pin; zip checked against HashiCorp's SHA-256 list) and `hashicorp/aws` 6.69.1 (signed, hashes from the repository lockfile) rendered them with credential validation, account lookup and the metadata API switched off, so no AWS call was made.
- **Evaluation.** `aws iam simulate-custom-policy`, one call per case: an identity policy allowing `s3:*` and `kms:*`, so only the bucket policy decides, with the rendered bucket policy as the resource policy and the request's headers as context keys (`aws:SecureTransport`, `s3:TlsVersion`, `s3:x-amz-server-side-encryption`, `...-aws-kms-key-id`, `...-customer-algorithm`). The backup-job cases use the rendered `backup_job` document as the identity policy. Each case's expected decision was written before the run; the run fails on any difference.
- **Account.** A founder-approved AWS profile; only `sts get-caller-identity` and `iam simulate-custom-policy` were called, both read only. No account id is recorded here.

## Results: 23 of 23 as expected

| Case                                                       | Reports bucket                  | Backups bucket                  |
| ---------------------------------------------------------- | ------------------------------- | ------------------------------- |
| `aws:kms` with the bucket's own key ARN (positive control) | allowed                         | allowed                         |
| No encryption header (the bucket default applies)          | allowed                         | allowed                         |
| `AES256`                                                   | denied, `DenyOtherEncryption`   | denied, `DenyOtherEncryption`   |
| `aws:kms` with the other bucket's key                      | denied, `DenyOtherKey`          | denied, `DenyOtherKey`          |
| `aws:kms` with no key id (I3)                              | denied, `DenyManagedKey`        | denied, `DenyManagedKey`        |
| SSE-C                                                      | denied, `DenyCustomerKeys`      | denied, `DenyCustomerKeys`      |
| `aws:kms` with the right key as a bare key id              | denied, `DenyOtherKey`          | denied, `DenyOtherKey`          |
| Plain HTTP                                                 | denied, `DenyInsecureTransport` | denied, `DenyInsecureTransport` |
| TLS 1.1                                                    | denied, `DenyOldTls`            | (no TLS rule on this bucket)    |

| Backup job (identity policy)                       | Result            |
| -------------------------------------------------- | ----------------- |
| `s3:PutObject` on the backups bucket               | allowed           |
| `s3:PutObjectRetention` on the backups bucket (I2) | allowed           |
| `kms:GenerateDataKey` on the backup key            | allowed           |
| `s3:BypassGovernanceRetention`                     | implicitly denied |
| `s3:PutObject` on the reports bucket               | implicitly denied |
| `kms:GenerateDataKey` on the data key              | implicitly denied |

The statement each denial matched was read from the simulator's line positions in the rendered JSON; every one is the statement named above.

## Seen failing

With `DenyManagedKey` removed from the rendered reports policy, the I3 case came back **allowed** and the run reported 22 of 23 with the difference named. The check can go red.

## Meaningful findings

- A KMS key named as a bare key id, not its full ARN, is refused by `DenyOtherKey`: the condition compares the header with the ARN. Nothing says so yet. `docs/ops/offsite-backups.md` describes `BACKUP_S3_KMS_KEY_ID` without naming the form, and `offsite.ts` and `s3-evidence-storage.ts` send the configured value as given. Today the documented setup leaves it unset (the bucket default applies), so nothing is refused; anyone who sets it must use the full key ARN. Stating that in the runbook, or checking the form when the setting loads, is a follow-up.

## Not verified

- The simulator evaluates IAM policy logic, not S3 itself: it does not show which key S3 actually uses for an upload with no header (the bucket default), or for `aws:kms` with no key id. Checked in S3 on 2026-10-29 ([s3-default-key-check.md](s3-default-key-check.md)), which also found that S3 refuses the I3 case even without `DenyManagedKey`, where the simulator allowed it.
- The access-logs and audit buckets were not simulated; the audit bucket has no encryption denies, which is a separate review.
- Nothing is deployed, so no live bucket was checked.
