# Fix: the evaluation worker's queue pool has limits, and its stop has a deadline (local)

Date: 2026-10-28

Found by the 2026-10-27 audit (W5). The audit's third point, that `stop()` always exited 0, was already fixed by W3 (#118).

**The problem** (`apps/backend/src/evaluation-worker.ts`; the worker is off and in no deployment, so this is latent).
- The queue pool had no client-side limits. The queue login has server-side statement limits, but nothing bounded the wait for a new connection, and nothing ended a query on a half-open connection the server cannot cancel.
- `stop()` had no overall deadline: if the database stopped answering while the runner released jobs, the pool closed or the application closed, the stop waited until the process was killed from outside.
- The file worker (`apps/worker`) already had both: `WORKER_POOL_LIMITS` and `createShutdown`. The backend cannot import from another app.

**The fix.**
- `WORKER_POOL_LIMITS` and a general `boundedStop` (named steps, a deadline, `shutdown-forced` and exit 1 when it passes, a failing step logged by name) move to `@telesphoros/jobs`, as `log.ts` did. `SHUTDOWN_GRACE_SECONDS` and `shutdownDeadlineMs` move with them.
- `apps/worker` re-exports them; its `createShutdown` is now its four steps (health, tickers, runner, pool) on `boundedStop`, with the same behaviour and log lines.
- The evaluation worker spreads `WORKER_POOL_LIMITS` into its queue pool and stops through `boundedStop` (runner, queue pool, application), with the deadline `shutdownDeadlineMs(drainSeconds)`. A runner that fails to release a job still makes the exit 1 (W3).

**Not changed.** The application's `Database` pool (it has its own limits), the runner's drain, the login settings in `provision-logins.ts`, Terraform, and the evaluation worker staying off and undeployed.

**The tests.**
- `apps/worker/src/shutdown.test.ts`, `boundaries.test.ts` and `deploy-contract.test.ts` pass unchanged (79 of 79): the file worker's stop behaves as before.
- `packages/jobs/src/shutdown.test.ts` (new): order, a second signal, the deadline with a step that never finishes, a failing step logged by name with no error text.
- `apps/backend/test/evaluation-worker-bounded.spec.ts` (new): source pins, as the file worker has, that the evaluation worker builds its pool with the limits and stops through `boundedStop` with the drain deadline. Red before the change (3 of 3).
- `apps/worker/test/pool-limits.pg.test.ts` on PostgreSQL 16, now reading the limits through the re-export: 5 of 5 (statement and idle-transaction limits applied by the server, a silent server refused in about 2 s).
- Suites on PostgreSQL 16 and Moto: `@telesphoros/jobs` 20 of 20; worker 19 files, 241 tests; backend 255 suites passed, 0 failed, 2 skipped (`local-storage-bounds`, `local-storage-cleanup`, which skip under `TEST_STORAGE=postgres`), 3396 tests. Typecheck and lint pass.

**Not verified.** The evaluation worker process was not started and stopped end to end (it needs the full evaluation profile); its behaviour rests on the shared helper's tests and the source pins. Not verified in AWS.
