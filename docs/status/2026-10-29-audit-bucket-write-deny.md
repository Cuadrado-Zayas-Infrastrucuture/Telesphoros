# Fix: only the audit trail can write to the audit log bucket (not applied)

Date: 2026-10-29

Found by the audit bucket review that followed the bucket-policy simulation (#144).

**The problem.** The audit bucket policy (`infrastructure/terraform/audit.tf`) only allowed this trail to write. In the same account an Allow-only bucket policy limits nobody: an identity policy that grants `s3:PutObject`, such as an administrator's, could still write there. The trail does not record ordinary writes in this bucket (`docs/ops/audit-trail.md`), so a file added under `AWSLogs/` would leave no trace. The guard said "only CloudTrail may write" but checked only that the Allow statements were CloudTrail's. Nothing is applied.

**The fix.**

- `DenyWritesNotFromThisTrail` refuses `s3:PutObject` on every object to any request whose `aws:SourceArn` is not this trail (`StringNotEqualsIfExists`, so a request with no source, which is every IAM user and role, is refused).
- By decision, encryption denies like the reports bucket's were not added: once only this trail can write, they add nothing, and a mismatch with how CloudTrail names its key would stop log delivery without an error.
- Deletes are left to the Object Lock and to the trail, which records them; denying them would also stop `force_destroy` in the synthetic environment.
- `audit.guard.test.mjs` requires the statement, with three controls (made an Allow, narrowed to another action, every source exempted). `docs/ops/audit-trail.md` says so.

**Checked.**

- The guard failed on the old text, naming the missing deny, and passes now; `pnpm test:infra` 150 of 150.
- IAM policy simulator, read only, on the policy rendered by Terraform 1.16.5 and `hashicorp/aws` 6.69.1 with no AWS call: an administrator's write is denied by this statement; a write carrying this trail's `aws:SourceArn` is allowed; another trail's is denied; reads and deletes are unchanged (5 of 5). With the statement removed, both writes came back allowed.
- `pnpm test:ci-config` failed once with its output discarded, then passed four times with the machine's load near 9 on 10 cores. This change touches no file it reads; the cause of that one failure is not known.

**Not proven.** The simulator cannot act as CloudTrail itself, so real log delivery under the deny is unproven until a trail is applied. A non-production trail, or the first applied environment, would show it. A throwaway trail did, the same day: [2026-10-29-audit-trail-delivery-check.md](2026-10-29-audit-trail-delivery-check.md).
