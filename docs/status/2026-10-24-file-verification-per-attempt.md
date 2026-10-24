# A job may leave one file-check row per attempt: item 41 declined (2026-10-24)

Date: 2026-10-24

**No code change.** The production audit (item 41) said `file_verifications` has only `UNIQUE (seq)`, so a redelivered job writes a duplicate finding and a duplicate alarm, and recommended a unique key per job. Re-read on `main` 528b158, the rows it calls duplicates are not duplicates, and the key would do harm.

**Evidence.** A redelivery is a later attempt of the same job (a crash, a lost lease, or a retryable failure such as `storage-unreadable` or `handler-aborted`). Each attempt checks the file again, so each records what it saw. The repository already tests exactly this: `apps/worker/test/consumers.s3.test.ts`, "a retry of the same job looks again at the report the first attempt could not read, and a good read then ends it", asserts the rows for one report and one job are `['unreadable', 'ok']`. A unique key on (job, report) would refuse the second row, so the corrected observation, the one the stale-check selector reads as the newest, would never be stored and the report would look unreadable until the next cycle. Within one attempt `files.verify-stored` records once and `files.verify-stale` once per report, and the stale selector skips a report an earlier attempt already verified, so no double record happens inside an attempt. The alarm counts failed checks; one failed attempt raising it once is wanted, and a later good attempt does not raise it.

**What changed.** Only words: `docs/ops/jobs.md` now says that several rows per job and report are deliberate and why. No migration, no test added (the existing one already pins the behaviour).

**Limits.** If a duplicate within a single attempt were ever found (two records for one job, report and attempt), a key including the attempt number would be the right shape; nothing in the code can produce that today, and the job row's attempt counter is not passed to the recording function.
