# Verification: which key S3 applies to a reports upload, against the rendered reports bucket policy

Date: 2026-10-29

Scope: audit item I3 on the reports bucket. The IAM policy simulator ([bucket-policy-simulation.md](bucket-policy-simulation.md)) evaluates the policy logic but not S3 itself, so it could not show which key S3 uses for an upload with no encryption header, or for `aws:kms` with no key id. This check asked S3. `storage.tf` is unchanged between `fefcb31`, where the policy was rendered, and `main` `8fb9bce`.

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

## Not verified

- The backups bucket: its `DenyManagedKey` is the same statement, but it was not tested in AWS.
- Nothing is deployed, so no live bucket was checked; the resources here were created for the check and removed.
