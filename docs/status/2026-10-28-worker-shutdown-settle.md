# Fix: shutdown no longer releases a finished job, and an incomplete stop exits 1 (local)

Date: 2026-10-28

Found by the 2026-10-27 audit (W3, W4).

**The problems.**
- **W4.** On stop, the runner released every job still in its running set, including one whose handler had finished and whose outcome `settle()` was still retrying (up to 7.5 s while the database is briefly unavailable). If the release landed first, a finished job went back on the queue with its attempt not counted and ran again.
- **W3.** A failed release at stop was logged, but `stop()` returned normally, so the worker exited 0 (`apps/worker/src/shutdown.ts`). The evaluation worker (`apps/backend/src/evaluation-worker.ts`) always exited 0. A job left that way is recovered by lease expiry, and on its last attempt that dead-letters it, while the stop read as clean.

**The fix** (`packages/jobs/src/runner.ts`, shared by both workers).
- A running entry is marked `settling` once its handler is done and its outcome is being reported. `stop()` does not release such an entry; it waits up to 8 s for it (within the 15 s shutdown grace).
- `stop()` throws `shutdown-incomplete` when a release failed or an outcome was not recorded, after logging `worker-stopped` at `error` with the count. The worker's stop sequence already turns a thrown step into exit 1; the evaluation worker now closes its pool and application and exits 1.

**Not changed.** The queue functions, leases, the drain, `SHUTDOWN_GRACE_SECONDS`, the health endpoint and the tickers. A job left to lease expiry is still recovered the same way; what changes is that the exit code says so.

**The tests** (`apps/worker/src/runner.test.ts`): a stop during an outcome retry does not release the job and the outcome lands; a stop whose outcome never lands rejects; a stop whose release fails rejects. The existing stop test (release succeeds) is the control and still resolves. Each fix was removed once and its tests went red. The evaluation worker's `main()` has no unit test; its change is read in code.

Not verified in AWS. Whether anything in the deploy path reacts to an old task exiting 1 was not checked (the ECS deployment circuit breaker counts the new deployment's tasks, as AWS documents it; not tested here).
