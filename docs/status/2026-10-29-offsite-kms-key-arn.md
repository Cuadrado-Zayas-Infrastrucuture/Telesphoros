# Fix: off-site backup settings refuse a KMS key the bucket would refuse

Date: 2026-10-29

Follows the IAM policy simulation (`docs/verification/bucket-policy-simulation.md`, #144), which found that a key named any way but its full ARN is refused.

**The problem.** `loadOffsiteSettings` (`apps/backend/src/db/offsite.ts`) accepted two settings that the backups bucket policy refuses at upload, after the dump has been taken:

- `BACKUP_S3_SSE=aws:kms` with no `BACKUP_S3_KMS_KEY_ID`: the upload names `aws:kms` with no key id, refused by `DenyManagedKey`.
- A key given as a bare key id or an alias: refused by `DenyOtherKey`, which compares the full ARN.

The same applies to `--kms-key-id` on the command line, which goes through the same loader. The documented set-up (both unset, the bucket default encrypts) was not affected.

**The fix.** With `aws:kms`, the loader requires a key, and the key must be a full KMS key ARN (any partition). Otherwise it throws `OffsiteError`, naming the setting and never the value. The settings load before the dump (`uploadTarget` is evaluated before `createBackup` runs), so a wrong setting stops the backup before any work. `docs/ops/offsite-backups.md` says the key is the full ARN and required with `aws:kms`.

**Not changed.** The upload code, the bucket policies and Terraform, and the evidence store, whose key comes from the authenticated recovery catalogue rather than a setting.

**The tests.** `src/db/offsite-settings.spec.ts` (new, runs without S3): no header and a full ARN (also a multi-Region key in another partition) load; `aws:kms` with no key, a bare id, an alias name, an alias ARN, an ARN of another service and an ARN with a short account are refused from the environment and from the command line, and the message never contains the value. Red before the fix (6 of 8).

**Suites.** On PostgreSQL 16 and Moto the whole backend ran: every off-site spec passed (`offsite-settings` 8, `offsite-restore.pg` 9, `offsite.s3` 24, `offsite-discovery` 20), and 17 unrelated suites failed, every one on a timeout or, in `issuer-server.spec.ts`, a timing bound, while the machine's load average peaked at 11 on 10 cores. Rerun alone, the 17 passed (323 tests). The cause is likely CPU contention; it is not proven. Typecheck and lint pass.
