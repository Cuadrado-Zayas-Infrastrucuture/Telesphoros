# Verification: which key S3 applies to a reports or backups upload, against the rendered bucket policies

Date: 2026-10-29

Scope: audit item I3 on the reports bucket. The IAM policy simulator ([bucket-policy-simulation.md](bucket-policy-simulation.md)) evaluates the policy logic but not S3 itself, so it could not show which key S3 uses for an upload with no encryption header, or for `aws:kms` with no key id. This check asked S3, for the reports bucket and then for the backups bucket ([below](#backups-bucket)). `storage.tf` is unchanged between `fefcb31`, where the policies were rendered, and `main` `1e65cfa`.

## Method

- **Founder-approved, throwaway resources** in a non-production account, region `us-east-2` (the Terraform default): one customer-managed KMS key, tagged as a throwaway, and one bucket per run (three runs), each with the reports bucket's default encryption (`aws:kms` with that key, bucket key on). No account id is recorded here.
- **The rendered policy, not a hand copy.** The reports bucket policy rendered for the simulation, with its example bucket name and key ARN replaced by the throwaway bucket and key (the replacement count was asserted). All six statements are denies to every principal, so the caller's own full access does not hide them.
- **Uploads** of a 1-byte synthetic object with `aws s3api put-object`; the key used read back with `head-object`, and keys compared inside the script, so no ARN was printed. A refusal kept AWS's error text, with ARNs and account ids masked.
- **Cleanup on exit:** objects and buckets deleted (a listing afterwards found none), and the key scheduled for deletion with the 7-day minimum. The AWS-managed `aws/s3` key already existed in the account before the check; nothing else was created.

## Results

With the full rendered policy:

| Upload                                                     | Result                                    |
| ---------------------------------------------------------- | ----------------------------------------- |
| No encryption header (how the application uploads reports) | Accepted, encrypted with the bucket's key |
| `aws:kms` with no key id (I3)                              | Refused (`AccessDenied`)                  |
| `aws:kms` with the bucket's key ARN                        | Accepted, encrypted with that key         |
| `aws:kms` naming `alias/aws/s3`                            | Refused                                   |
| `AES256`                                                   | Refused                                   |

The same `aws:kms` upload with no key id, on one bucket under three policies:

| Bucket policy                                | Result                                                                                                        |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| None                                         | **Accepted, encrypted with the AWS-managed `aws/s3` key**, although the bucket default names the customer key |
| The rendered policy without `DenyManagedKey` | Refused: "explicit deny in a resource-based policy"                                                           |
| The full rendered policy                     | Refused, the same message                                                                                     |

## Meaningful findings

- **I3 holds in S3 itself.** A request that names `aws:kms` without a key id does not get the bucket's default key: S3 uses the AWS-managed `aws/s3` key. Without the bucket policy such an object would be outside the data key.
- **The simulator understates the policy here.** Under the simulator, with `DenyManagedKey` removed, this upload came back allowed (the "Seen failing" case of the simulation). S3 refused it: it evaluates the key-id condition against the key it chose, so `DenyOtherKey` already refuses the request and `DenyManagedKey` is a second barrier, not the only one. The statement is inferred by elimination (AWS's message names the policy type, not the statement): of the other four, two need an insecure or old-TLS request, one an encryption other than `aws:kms`, and one a customer-supplied key, and this request had none of those.
- **The application is unaffected.** It sends no encryption header, and such an upload gets the bucket's key.

## Backups bucket

The same check against the rendered backups bucket policy, with one new throwaway KMS key and one bucket, both removed afterwards (the key is pending deletion). Two differences in method:

- **Region `us-east-2`, not the backup region.** The backups bucket lives in `backup_region`, whose Terraform default is `us-east-1`. There this account's role was refused `kms:CreateKey` (no identity-based policy allows `kms:TagResource`), and `kms:ListKeys` is refused by an explicit deny in a service control policy; nothing was created. The bucket policy does not depend on the region, so the check ran in `us-east-2`.
- **No Object Lock.** The backups bucket policy requires no lock header (the backup job's need for `s3:PutObjectRetention` is an IAM matter, checked by the simulator), and the lock does not change which key S3 picks. Without it the bucket could be deleted at once.

| Upload                                                 | Result                                                |
| ------------------------------------------------------ | ----------------------------------------------------- |
| `aws:kms` with no key id, no bucket policy             | Accepted, encrypted with the AWS-managed `aws/s3` key |
| The same, the rendered policy without `DenyManagedKey` | Refused: "explicit deny in a resource-based policy"   |
| No encryption header, full policy                      | Accepted, encrypted with the bucket's key             |
| `aws:kms` with no key id, full policy                  | Refused                                               |
| `aws:kms` with the bucket's key ARN, full policy       | Accepted, encrypted with that key                     |
| `aws:kms` naming `alias/aws/s3`, full policy           | Refused                                               |
| `AES256`, full policy                                  | Refused                                               |

The same outcomes as the reports bucket: I3 holds, the policy refuses it, and `DenyOtherKey` is enough on its own in S3.

## Not verified

- The backup region itself: a first apply with the default `backup_region` (`us-east-1`) may fail on the backups KMS key in this account, as `kms:CreateKey` did here. A later probe the same day (one tagged throwaway key, as Terraform's `default_tags` would create it) was refused in `us-west-2` too, by an explicit deny in a service control policy; nothing was created. So the region is the organization's choice (decision D1), not the default's. Unproven: the role that applies Terraform may have other permissions, and no apply was attempted. [offsite-backups.md](../ops/offsite-backups.md#limits-stated-plainly) says to check it first.
- Nothing is deployed, so no live bucket was checked; the resources here were created for the check and removed.
