# Fix: every worker process gets its own id (local)

Date: 2026-10-27

Found by the 2026-10-27 audit (W1).

**The problem.** Without `WORKER_ID`, which Terraform forbids setting, the worker id was `worker:<pid>`. The image runs node as PID 1 in every container, so every production task was `worker:1`.

**Why it mattered.** Every lease function fences on that id: heartbeat, succeed, fail, release and `job_held`. With one shared id:
- A task whose lease expired kept heartbeating after another task reclaimed the job.
- The stalled task could also mark the job succeeded while the new holder was still running it.
- Old and new tasks overlap on every deploy.

On PostgreSQL 16, a stale heartbeat and a stale succeed under the shared id both returned true.

**The fix.** The default is now `worker:<pid>:<random 8 hex>`. It uses `node:crypto`, because the worker's boundary test forbids `node:os`. `docs/ops/jobs.md` gives the new default.

**The test.** `config.test.ts` builds two ids the way two containers would (PID 1, no `WORKER_ID`) and requires them to differ:
- Without the fix it fails.
- With the fix it passes.

**Not covered.** A worker reclaiming its own expired job (audit W2) needs a per-claim token and is not fixed here.
