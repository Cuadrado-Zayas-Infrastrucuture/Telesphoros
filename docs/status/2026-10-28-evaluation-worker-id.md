# Fix: the evaluation worker's default id is unique per process (local)

Date: 2026-10-28

Follow-up to the 2026-10-27 audit (W1, W2).

**The problem.** Without `WORKER_ID`, the backend's evaluation worker named itself `hostname:pid`. Every container runs node as PID 1, so two of them with the same host name got the same id. Since W2 every claim has its own holder, so leases and fences were already safe; what was left is that the two would share one `job_workers` row. The evaluation worker is off by default, needs the lab-report pipeline (refused in production) and is started by nothing in Terraform, so this affected local and synthetic runs only.

**The fix.** The default id is `hostname:pid:<random 8 hex>`, as W1 made the main worker's (`apps/worker/src/config.ts`). A `WORKER_ID` that is set is used exactly as given.

**The tests.** `evaluation-worker-config.spec.ts`: two loads with the same host name and PID 1 give different ids of that form (red before: both were `evaluation-worker:1`), and a set `WORKER_ID` is kept (control). Removing the random part turns the spec red again.

Not verified in AWS (nothing deploys this worker).
