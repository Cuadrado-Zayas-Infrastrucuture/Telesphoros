# Background jobs: the queue, the worker and the operator command

Synthetic data only. Nothing here is applied in AWS, and no job in this milestone touches a clinical record. Built in [M2.3a](../design/plans/m2-3-jobs-outbox-worker.md#m23a-as-built-and-where-it-differs-from-the-plan) ([verification](../verification/m2-3a-queue-core.md)) and [M2.3b](../design/plans/m2-3-jobs-outbox-worker.md#m23b-as-built-and-where-it-differs-from-the-plan) ([verification](../verification/m2-3b-outbox-consumers.md)); the deployment (Terraform, alarms, image target) is M2.3c.

## What exists

- **A queue in PostgreSQL** (migration 0023): `jobs` (the work), `job_attempts` (one append-only row per run, no payload and no message), `job_schedules` (the recurring types) and `job_workers` (who was seen when). They belong to the role `telesphoros_jobs`, and the only way to change them is a handful of `SECURITY DEFINER` functions. The application login can enqueue (`job_enqueue`) and read its own organization's rows; the worker login can claim and report (`job_claim`, `job_heartbeat`, `job_succeed`, `job_fail`, `job_release`, `job_schedule_tick`, `job_worker_seen`, `job_stats`) and read; **neither can insert, update or delete a row, or read any other table**.
- **A worker process** (`apps/worker`, one self-contained bundle): claim loop, leases with heartbeats, retry with backoff, dead letters, a scheduler, a drain on shutdown, and a loopback health endpoint. It holds no clinical credentials. It registers the production job types below (the file jobs only when it has a bucket); the test job types are registered only when `WORKER_TEST_JOBS=yes` outside production.
- **`packages/jobs`**: what the API and the worker share (job definitions, the registry, the flat-payload rule, error codes, the backoff formula, the system-actor name, the queue client).
- **An operator command**: `node dist/db/cli.js jobs ...` (below).

## Delivery rules

- **At-least-once.** A claim takes a lease (the shortest `leaseSeconds` among the types a worker runs; the heartbeat renews it every third of that). A worker that dies loses the lease; the job is claimed again and the loss is recorded as `lease-expired`. A handler must therefore be idempotent. Exactly-once is not claimed.
- **Retries.** A retryable failure waits 60 s, then 300 s, 1500 s ... capped at 3600 s, each ±20 %; after `max_attempts` (default 5, at most 20) or on a fatal failure the job is **dead**: kept, visible, and never retried by the system. Only a person re-queues it.
- **Shape rules in the database.** A payload is a flat object of short lower-camel keys with integers, booleans and strings of letters, digits and hyphens (at most 64 characters, 1 KiB in all): no nesting, no text, no filename, no patient value. An error code is a short code (`^[a-z][a-z0-9-]{1,47}$`); a handler's exception message is **never** stored or logged (an unexpected error becomes `handler-error`).
- **Fairness.** At most `WORKER_TENANT_CAP` (default 2) running jobs per organization across all workers, decided under a per-organization advisory lock; an organization at its cap does not hide the others' jobs. A claimer that finds an organization being served by another claimer leaves it for the next round rather than waiting (waiting could deadlock).
- **Suspended organizations.** Their jobs are **held, not claimed**; they run after the organization is activated (nothing is lost, nothing runs). Removing a person does not cancel their organization's jobs (a job belongs to the organization).
- **The actor.** A job runs as the system actor `system:<job type>` (the scheduler as `system:scheduler`). That name is **never a person**: the database refuses it as `created_by` on every table that records a human decision or assertion (captures accepted, disputes and their decisions, corrections, patient-link decisions, merge proposals and decisions, patient identifiers and their withdrawal) and as a membership's subject, the authentication layer refuses a token whose subject starts `system:`, and the membership command refuses it. No independence rule ("someone other than who registered it", "a second person") can be satisfied by a job.
- **Handlers reach data through services only.** The worker is given no repository and no SQL. A source-level test lists what a handler may import (Node built-ins, `zod`, `@telesphoros/jobs`, the runner's types) and that no handler names a clinical table. The rule for the first clinical handler (M3.x): it goes through `EvaluationsService` and the other services, never around them.

## The consumers (M2.3b)

| Job type | Started by | What it does |
| --- | --- | --- |
| `files.verify-stored` | the outbox: every upload commit writes a `report.file-committed` event in its own transaction | Re-reads the **exact stored object version** the report is pinned to, hashes it, and compares size, content type and SHA-256 with the report. Records one row in `file_verifications` |
| `files.verify-stale` | the schedule, daily per organization | The same check for up to 25 of the organization's reports not checked for 30 days (never-checked first) |
| `uploads.sweep` | the schedule, hourly per organization | Closes abandoned upload attempts and returns their quota. Deletes nothing from the bucket. It is the same database function `uploads sweep` runs |

**The outbox.** The API writes `outbox_events` through `outbox_append`, inside the business transaction (the organization comes from the transaction): a rolled-back change leaves no event, a committed one cannot lose it. The worker calls `outbox_relay` every few seconds; it makes each event's job and marks the event in one transaction, keyed by the event, so a crash or two relays at once cannot lose or duplicate a job. An event for an organization that is not registered (a disposable local run) is marked `no-organization` and creates nothing; a suspended organization still gets its job and the claim holds it.

**A failed re-check** (`file_verifications.outcome` is `missing` or `changed`, with the reason `version-missing`, `size-mismatch`, `hash-mismatch` or `type-mismatch`) ends the job **dead** with `file-missing` or `file-changed`. It is a finding for a person: nothing is repaired, quarantined or deleted, and the report is not marked. `jobs dead` lists them; read the row with `jobs show`, find the report from the job's payload, and decide (restore a version from backup, contact the organization, or record why it is expected). `unreadable` (the bucket could not be read) is retried with backoff. Every check, good or bad, is an append-only row; there is no screen for it yet.

**How the worker is allowed to do this.** It is granted no table. Each function (`file_verification_target`, `file_verification_stale`, `file_verification_record`, `job_uploads_sweep`) takes the job id and the worker id and refuses unless that job is **running, held by that worker, and of the type the function serves**; it then acts for that job's organization only, with row-level security bound to it. The worker's access to the bucket is read-only, `GetObject` on a named version, in one file (`apps/worker/src/storage.ts`), and a test pins that no write command appears there.

## The worker

Environment (all validated at start; a refusal names the setting, never a value):

| Setting | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | required | The worker login (member of `telesphoros_worker` only). No TLS parameters in the URL |
| `DATABASE_SSL` | `disable` | `require` in production (production refuses `disable`) |
| `WORKER_ID` | `<host>:<pid>` | Short code recorded on leases and attempts |
| `WORKER_CONCURRENCY` | 4 | Jobs run at once (1 to 50) |
| `WORKER_TENANT_CAP` | 2 | Running jobs per organization, across all workers |
| `WORKER_POLL_MS` | 2000 | Idle wait between claims |
| `WORKER_DRAIN_SECONDS` | 30 | How long a stop signal lets running jobs finish |
| `WORKER_SCHEDULE_TICK_SECONDS` | 30 | How often it asks the database to enqueue due recurring jobs |
| `WORKER_HEALTH_HOST` / `_PORT` | `127.0.0.1` / 8081 | Health endpoint (`/livez`, `/readyz`; counts only) |
| `WORKER_RELAY_SECONDS` | 5 | How often pending outbox events become jobs |
| `REPORTS_BUCKET` | none | The bucket the stored-file re-check reads (read-only). **Required in production**; without it the file jobs are not registered (logged as `job-types-disabled`) |
| `S3_ENDPOINT`, `S3_FORCE_PATH_STYLE`, `AWS_REGION` | none | For an S3-compatible server in development and tests; AWS credentials come from the environment's role |
| `WORKER_TEST_JOBS`, `WORKER_TEST_EFFECT_DIR` | `no` | Test job types; refused when `NODE_ENV=production` |

`SIGTERM`/`SIGINT` drains: it stops claiming, waits up to `WORKER_DRAIN_SECONDS` for running jobs, **releases** what is left (the unmade attempt is not counted) and exits 0. A hard kill leaves leases that expire; nothing else is needed.

Its log is one JSON line per event with a fixed set of fields (worker id, job id, job type, attempt, outcome code, counts). Any string that is not a short code is dropped, so a payload value or an error message cannot be written.

## Operator command

`DATABASE_MIGRATOR_URL` (the table owner; it holds `telesphoros_jobs` by `SET` only, and the command acts as that role inside one transaction).

```
jobs status                                   counts and the age of the oldest ready job, by type and state; workers seen
jobs list [--tenant ID] [--type T] [--state S] [--limit N]
jobs dead [--tenant ID] [--limit N]           the dead letters (an alarm in M2.3c)
jobs show --id JOB_ID                         the job, its payload (ids and codes) and its attempt history
jobs retry --id JOB_ID --by NAME              re-queue one DEAD job with fresh attempts
jobs cancel --id JOB_ID --by NAME             stop a job that has not started (queued or waiting to retry)
```

`retry` and `cancel` add an `operator-requeued` / `operator-cancelled` row to the job's history under `operator:<name>`. A running job cannot be cancelled: let it finish or lose its lease. Nothing deletes or edits a record (the history is append-only even for the owner).

**A dead job is a decision, not a chore.** Read `jobs show`, find out why from the error code and the log, fix the cause, then retry. Retrying a job whose cause is not fixed only produces another dead letter.

## Not yet (carried to M2.3c)

The ECS service for the worker, its read-only bucket role, the alarms (a dead job, a stale worker heartbeat, a queue that is not draining, a failed file check), the image target and CI image guard, and the worker's database login in `provision-logins` with its Terraform secret. Until then the worker is run by hand or in tests, and no environment has one. A screen for the verification record, and a notification when a check fails, belong to a later slice.
