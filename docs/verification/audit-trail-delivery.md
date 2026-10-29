# Verification: CloudTrail delivers to a bucket carrying the audit bucket policy

Date: 2026-10-29

Scope: audit item I4. #150 added `DenyWritesNotFromThisTrail` to the audit log bucket (`infrastructure/terraform/audit.tf`), so only this account's trail may write there. The IAM policy simulator checked the logic but cannot act as CloudTrail, so whether the trail can still deliver under the deny was unproven ([2026-10-29-audit-bucket-write-deny.md](../status/2026-10-29-audit-bucket-write-deny.md)). This check asked CloudTrail. `audit.tf` is unchanged since `837812d`, the commit the policy was rendered from.

## Method

- **Founder-approved, throwaway resources** in a non-production account, region `us-east-2`: one customer-managed KMS key, one bucket and one single-region trail. No account id is recorded here.
- **The bucket policy is the rendered one.** The audit bucket policy rendered from `audit.tf` for the simulation, with its example trail ARN, bucket name and account replaced by the throwaway ones (the replacement counts and the five statement ids were asserted). The bucket matched `audit.tf` in ownership (`BucketOwnerEnforced`) and default encryption (`aws:kms` with the key, bucket key on).
- **The key policy is a hand copy** of `audit.tf`'s statements for the account and for CloudTrail (`AccountAdministration`, `CloudTrailEncryptLogs`, `CloudTrailDescribeKey`), with the trail's ARN. It is not what this check tests; the CloudWatch statements were left out with the log group.
- **The trail** was created with log file validation and global service events, as in `audit.tf`, and started; the bucket was polled every 30 seconds for up to 20 minutes.
- **A read-only probe** of `cloudtrail:DescribeTrails` ran first.
- **Cleanup on exit:** the trail deleted, the objects and bucket deleted, and the key scheduled for deletion with the 7-day minimum. Listings afterwards found no trail or bucket left.

## Results

| Step                                                                                 | Result                                                   |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| Read-only probe                                                                      | Allowed                                                  |
| Control: the account's own full-access role writes a file under `AWSLogs/<account>/` | Refused (`AccessDenied`)                                 |
| `CreateTrail` (CloudTrail checks at creation that it can write to the bucket)        | Accepted                                                 |
| First log file under `AWSLogs/<account>/CloudTrail/`                                 | Delivered within 30 seconds, encrypted with the test key |
| Trail status after delivery                                                          | Logging, no delivery error                               |

## Meaningful findings

- **The deny does not stop the trail.** CloudTrail sends this trail's `aws:SourceArn`, so `DenyWritesNotFromThisTrail` lets it through, while the same write from an administrator is refused.
- **The control's cause is inferred.** The captured refusal text was cut before the clause that names the policy type. A full-access role is refused only by an explicit deny. In the bucket policy, the only statement that matches this request is `DenyWritesNotFromThisTrail` (the other two denies need an insecure or old-TLS request). An organization policy denying `s3:PutObject` is not ruled out by the text, but the same role wrote objects to other buckets in this account the same day.

## Not verified

- **Object Lock:** the throwaway bucket had none, so its log files could be deleted at once. The lock does not change who may write.
- **The CloudWatch Logs side** of the trail: the log group, its role and the metric filters.
- **A multi-region trail,** which only the production profile creates.
- **The key policy exactly as rendered,** and the alarms.
