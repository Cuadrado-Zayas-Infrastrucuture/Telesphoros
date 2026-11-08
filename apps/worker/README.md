# @telesphoros/worker

The separate process that runs queued jobs: it claims them from the PostgreSQL queue, runs the registered consumers and ticks the scheduler. **Synthetic data only.** It is not the API and it is not the gated evaluation worker (`apps/backend/src/evaluation-worker.ts`). What runs where, and since when: [docs/ops/environments.md](../../docs/ops/environments.md). Documentation map: [docs/README.md](../../docs/README.md).

| Look at | For |
| --- | --- |
| [`src/main.ts`](src/main.ts) | Start-up: configuration, database pool, the registered consumers (one reviewed line per job type), the health server, shutdown |
| [`src/runner.ts`](src/runner.ts), [`src/scheduler.ts`](src/scheduler.ts) | Claiming and running jobs; the tickers that enqueue the recurring ones |
| [`src/handlers/`](src/handlers) | The consumers: `uploads-sweep.ts`, `files-verify.ts`, and `test-jobs.ts` (registered only with `WORKER_TEST_JOBS=yes`, never in production) |
| [`src/config.ts`](src/config.ts) | Every environment setting and its validation |
| [`../../packages/jobs`](../../packages/jobs) | The queue, backoff and runner primitives the API and the worker share |

**Run and test**

```bash
pnpm --filter @telesphoros/worker test        # builds with tsup, then vitest
pnpm --filter @telesphoros/worker typecheck
pnpm --filter @telesphoros/worker lint
```

A plain `test` needs no services and prints `[vitest] NOT RUNNING` for the suites that start real worker processes against PostgreSQL (`TEST_DATABASE_URL`) and S3 (`TEST_S3_ENDPOINT`). Read that line before calling a run green: [the test commands and what each skips](../../docs/database.md#tests).

**Boundaries that tests pin**

- A job runs as the system actor `system:<job type>`, never as a person.
- The worker is granted no table. Each database function it calls takes the job id and the worker id and refuses unless that job is running and held by that attempt.
- Its access to the report bucket is read-only (`GetObject` on a named version, in `src/storage.ts`); `boundaries.test.ts` fails if a write command appears.
- No job in the current set touches a clinical record. Details and the operating commands: [docs/ops/jobs.md](../../docs/ops/jobs.md).

**Does not belong here:** API routes or request handling (`apps/backend`), shared queue primitives (`packages/jobs`), a new job's database function (a new migration under `apps/backend/migrations`, see [docs/database.md](../../docs/database.md)).
