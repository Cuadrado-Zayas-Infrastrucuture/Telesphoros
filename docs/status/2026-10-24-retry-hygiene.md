# Retry hygiene: one change, two declined (2026-10-24)

Date: 2026-10-24

**Implemented (no migration).** From the production-readiness audit (items 26 and 28), re-read on `main` 528b158.

**Built: the worker's pause after a failed claim now has jitter.** The claim loop waited `pollMs * 2^failures` (at most 30 s) with no randomness, so workers that lost the database at the same moment came back on the same tick. `claimBackoffMs` (exported from `runner.ts`) gives the same doubling and the same 30-second ceiling with up to 20% either way. Tests, red first: the function's values at the bottom, middle and top of the random range and its ceiling; and the claim loop itself, with `Math.random` pinned, waits 32, 64 and 128 ms for a poll interval of 20 ms (before: 40, 80, 160 for every worker). A deliberate breakage (no jitter) turns both red.

**Declined: `maxAttempts: 1` on the application and worker S3 clients (item 26).** The audit feared the SDK's default retry would resend an upload after a lost reply, get 412 from `If-None-Match: *` and leave an orphan. Measured against a local server that takes the whole body and then drops the connection: a streamed body (the upload path, `putStream`) is **not** sent again (the SDK logs "non-retryable streaming request" and fails), and a buffered body (`putObject`, no precondition, the same bytes) is sent again and succeeds. So the setting would change nothing for uploads and would remove a useful retry for buffered writes and for the worker's reads. `s3-retry-behaviour.spec.ts` pins the measurement (with the buffered case as a positive control; setting `maxAttempts: 1` turns it red), so an SDK upgrade that starts resending streams is caught. The audit's other point, the worker retrying any unexpected error (`runner.ts`), is unchanged and still open: each job type would need its own check that it is safe to repeat.

**Declined: jitter before the cap in `job_fail` (item 28).** The documented rule is "60 s, 300 s, 1500 s, capped at 3600 s, each plus or minus 20%": the cap comes first, so the longest wait is 4320 s (72 minutes). That is what the database and `retryDelaySeconds` do and what a test keeps in agreement. Changing the SQL would be a migration to move a retry by at most 12 minutes. Only the words changed: `docs/ops/jobs.md` and the comment in `backoff.ts` now say the cap comes first.

**Limits.** The SDK measurement used a local HTTP server, not S3, and one SDK version (the one in the lockfile). Real S3 behaviour on a lost reply was not observed. Not verified in AWS.
