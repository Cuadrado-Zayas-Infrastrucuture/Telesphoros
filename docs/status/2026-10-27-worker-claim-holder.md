# Fix: a worker that claims its own expired job again stops the old attempt (local)

Date: 2026-10-27

Found by the 2026-10-27 audit (W2).

**The problem.**
- Every queue fence (`job_heartbeat`, `job_succeed`, `job_fail`, `job_release`, `job_held` and the consumer functions that call it, `evaluation_job_fence`) compares `locked_by` with the worker id. When a worker's lease ran out while its handler still ran (a database outage about as long as the lease, or an abandoned handler after its timeout) and the same worker claimed the job again, `locked_by` was unchanged.
- So the old attempt kept passing every fence: its heartbeat kept the lease, and its succeed or fail settled the new attempt. Reproduced on PostgreSQL: after the reclaim, the old attempt's heartbeat returned true.
- The runner also overwrote its running entry for the job, and the old entry's cleanup then deleted the new one, so `stop()` could not see or release it.

**The fix (no migration).**
- `Runner` claims as a holder new on every claim, `<worker id>#<8 hex>`, and uses that holder for heartbeat, settle, release and the handler's `workerId`. The database fences are unchanged; they now tell two attempts of the same job apart. `workerSeen` keeps the bare id.
- When the same job is claimed while an attempt is still running, the old attempt is stopped first, and its cleanup removes only its own entry.
- `docs/ops/jobs.md` describes the holder. `jobs show` and the attempt log now print `<worker id>#<8 hex>`; the worker id stays the prefix.

**The tests.**
- `runner.pg.test.ts`: one runner reclaims its own expired job; the old holder's heartbeat and succeed are refused, and the attempts show two holders. Red on the old behaviour (the heartbeat returned true).
- `runner.test.ts`: a holder per claim reaches the handler and every queue call; a reclaim stops the old attempt and keeps the new one in the running set.
- Controls: using the bare id again turns the PostgreSQL test red (the stopped old attempt even settled the new one into retry); restoring the plain delete turns the runner test red.
- Worker tests that compared `locked_by` or `worker_id` with the bare id now match the worker id prefix (`heldBy` in `test/support.ts`).

Not verified in AWS.
