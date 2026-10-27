# The worker no longer reads a missing bucket as a missing file (2026-10-24)

Date: 2026-10-24

**Implemented (no migration).** From the production-readiness audit (item 37, Medium). `S3ObjectInspector` classed any HTTP 404 as `'missing'`, and `NoSuchBucket` is a 404, so a mistyped or deleted `REPORTS_BUCKET` would write a permanent `file-missing` finding for every report checked. Now only `NoSuchKey` and `NoSuchVersion` mean missing; any other failure to read throws, so the job retries and ends dead as an error, which the existing dead-job alarms already report.

**Start-up check.** The worker asks S3 once, for a key under `reports/`, and refuses to start (exit 1, `REPORTS_BUCKET names a bucket that does not exist.`, no value printed) only if S3 answers `NoSuchBucket`. It does not use `HeadBucket`, which needs `s3:ListBucket`, and the worker's role has none by design; no IAM change. NoSuchKey, AccessDenied, an outage and a five-second silence all let it start.

**Real S3, one read.** A signed `GetObject` on a random bucket name that cannot exist, through the `<profile>` profile (account <account>), returned HTTP 404 with `<Code>NoSuchBucket</Code>`, so the old code would have recorded it as missing and the check looks for the right answer. Nothing in the account was read or changed.

**Tests, written first.** `src/storage.test.ts`: red on the old code (`NoSuchBucket` and an unnamed 404 both came back `'missing'`); `bucketIsMissing` cases; a Moto test through the real SDK (`test/bucket-check.s3.test.ts`); and two process tests (`processes.pg.test.ts`): a worker with a bucket that is not there exits 1 without printing the value, and one with a real bucket starts. Disabling the check in `main.ts` turns the first red.

**Limits.** Not verified in AWS: (1) a versioned GET on a missing bucket (my second probe did not run: a shell argument did not split); (2) what the worker's role gets for a deleted object without `s3:ListBucket`. S3 is documented to answer 403 instead of 404 then, so a deleted file may show as a dead error job and not as `file-missing`; it still alarms. Granting `s3:ListBucket` on `reports/` would change that and widens a read-only role, so it is not done here. A bucket that exists but whose name belongs to another account is not detected. The dead `files.verify-*` alarm named alongside this item needs no work: `worker-job-dead`, `worker-dead-waiting` and `worker-file-check-failed` already cover it.
