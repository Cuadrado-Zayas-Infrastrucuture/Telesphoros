# Break-glass: deleting a stored report file version

A captured lab PDF is evidence ([report-evidence.md](report-evidence.md)): the records cite its exact version, and the application never serves a
different version in its place. **No principal in the Terraform module may delete object versions**, and an infrastructure test enforces that.
This page is the one exception: a role that exists only for the rare case where a version must be removed, who holds it, how it is used, and the
honest limits of the control.

**Status: described, not created. It must not be created for real use until the audit trail in "The audit gap" exists.** Nothing here has been
applied in AWS.

## When it may be used, and when it may not

May be used for, and only with a written decision first:

1. A legal order, or another legal duty, to remove a specific file.
2. A file stored in error whose removal the retention policy allows after review (for example, something that was never meant to be uploaded). The
   six-year floor on overwritten versions is the reason this needs a decision and not a click.
3. Incident response: removing an object that should not be there.

Never for: tidying, saving cost, shortening retention, or "making a test pass". Deleting the version a capture cites makes that evidence
unverifiable; the capture will then refuse to read (`source-missing`), and that is correct, not a fault to work around.

## Who holds it

- **Holder: the founder.** One named person, with multi-factor sign-in, and no standing access keys.
- **Hand-over rule.** When there is a second maintainer or a designated security/compliance owner, that person becomes the **approver**, and the
  holder may not approve their own use. Until then the founder writes the decision record first and tells the second key custodian after.
- The role is **not** assumable by the application, by the CI deploy roles, by GitHub Actions, or by any other role. Its trust names one human
  principal and nothing else.

## The role (text to create it from; not created)

It lives **outside** `infrastructure/terraform/` (that module may not grant version deletion), either created by hand by the account owner or in
a separate root with its own state. Replace the three placeholders; never commit real account or principal identifiers to this page.

Trust policy (who may assume it): one principal, only with MFA that is fresh.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "AWS": "<FOUNDER_IAM_PRINCIPAL_ARN>" },
      "Action": "sts:AssumeRole",
      "Condition": {
        "Bool": { "aws:MultiFactorAuthPresent": "true" },
        "NumericLessThan": { "aws:MultiFactorAuthAge": "900" }
      }
    }
  ]
}
```

Permissions: list versions, and inspect or delete named versions of objects in the reports bucket. Nothing else.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ListVersions",
      "Effect": "Allow",
      "Action": ["s3:ListBucketVersions"],
      "Resource": "arn:aws:s3:::<REPORTS_BUCKET>"
    },
    {
      "Sid": "InspectAndDeleteNamedVersions",
      "Effect": "Allow",
      "Action": ["s3:GetObjectVersion", "s3:DeleteObjectVersion"],
      "Resource": "arn:aws:s3:::<REPORTS_BUCKET>/*"
    }
  ]
}
```

Set the role's maximum session to **one hour** (3600 seconds). The role has no `kms:Decrypt`, so although it can see that a version exists, it
cannot read the file's contents: removing a file does not require seeing it.

## Using it (every time)

1. **Write the decision record first**, in your compliance records (not in the database, not in the repository): who, when, which bucket, key and
   version id, the basis (one of the three above), and who approved. If there is no approver yet, say so in the record.
2. Sign in with MFA and assume the role. Do the work in that one session.
3. List the versions of the one key (`ListBucketVersions` with the key as the prefix) and confirm the version id and size match the record. Do not
   use a wildcard or delete by prefix.
4. Delete **only** the version(s) named in the record.
5. List again and confirm they are gone and the other versions are untouched.
6. Close the decision record with the time, the version ids removed, and what you checked.
7. Check that the audit event exists (see below). If it does not, say so in the record.

## The audit gap (read this before creating the role)

The design says each use "is an audit event with a reason". **Today that is not true.** The Terraform has no CloudTrail. `AssumeRole` is a
management event that AWS keeps for 90 days in its event history, but `DeleteObjectVersion` is an S3 **data event**, which is recorded only if a
trail with data events for the reports bucket exists. Without one, a use of this role leaves no durable record except the decision record you
write yourself.

Before the role is created for real use, the hosting work (step H2) must add: a CloudTrail trail delivering to a protected bucket, S3 data events
for the reports bucket, and an alarm on `DeleteObjectVersion` and on any `AssumeRole` of this role. Until then, do not create it.

## Honest limits

- This is a **written control backed by IAM discipline**, not a technical lock. Anyone with IAM administrator rights in the account can grant
  themselves the same permission. Keep the number of such people at one, and review it (below).
- The reports bucket does not use Object Lock. A stronger arrangement (Object Lock in governance mode, so deletion needs a separate bypass right,
  or an organization policy that denies the action to everyone but this role) is a separate decision with costs; it is not built.
- Lifecycle rules, not people, remove noncurrent versions after the retention period. Do not shorten it ([report-evidence.md](report-evidence.md)).

## Reviewing that nobody else can do it

Quarterly, and after any change to IAM: for every role and user that can reach the reports bucket, ask the IAM policy simulator whether
`s3:DeleteObjectVersion` on an object in the reports bucket is allowed. The answer must be "implicitDeny" for every principal except this role.
Fill in the principal and bucket names yourself; the command does not guess them:

```
aws iam simulate-principal-policy --policy-source-arn <PRINCIPAL_ARN> \
  --action-names s3:DeleteObjectVersion --resource-arns arn:aws:s3:::<REPORTS_BUCKET>/any-key
```

Record the date and the result. A principal with "allowed" is a finding to fix the same day.
