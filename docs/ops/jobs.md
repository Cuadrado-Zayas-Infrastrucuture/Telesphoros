# Background jobs: the queue, the worker and the operator command

Synthetic data only. Nothing here is applied in AWS, and no job in this milestone touches a clinical record. Built in [M2.3a](../design/plans/m2-3-jobs-outbox-worker.md#m23a-as-built-and-where-it-differs-from-the-plan) ([verification](../verification/m2-3a-queue-core.md)) and [M2.3b](../design/plans/m2-3-jobs-outbox-worker.md#m23b-as-built-and-where-it-differs-from-the-plan) ([verification](../verification/m2-3b-outbox-consumers.md))and [M2.3c](../design/plans/m2-3-jobs-outbox-worker.md#m23c-as-built-and-where-it-differs-from-the-plan) ([verification](../verification/m2-3c-worker-deploy.md)): the deployment (Terraform written, not applied; alarms; image target; the worker login).

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
jobs dead [--tenant ID] [--limit N]           the dead letters (an alarm raises when one appears)
jobs show --id JOB_ID                         the job, its payload (ids and codes) and its attempt history
jobs retry --id JOB_ID --by NAME              re-queue one DEAD job with fresh attempts
jobs cancel --id JOB_ID --by NAME             stop a job that has not started (queued or waiting to retry)
```

`retry` and `cancel` add an `operator-requeued` / `operator-cancelled` row to the job's history under `operator:<name>`. A running job cannot be cancelled: let it finish or lose its lease. Nothing deletes or edits a record (the history is append-only even for the owner).

**A dead job is a decision, not a chore.** Read `jobs show`, find out why from the error code and the log, fix the cause, then retry. Retrying a job whose cause is not fixed only produces another dead letter.

## Deployment (M2.3c; written, never applied)

The worker is the **same image as the API**, started with the command `node worker/main.js` (the image holds `dist/main.js` for the API and `worker/main.js`, a single bundle, for the worker). Terraform is `infrastructure/terraform/worker.tf` and follows the API's switch: it exists only when `enable_api_hosting` is on, and its task definition and service also need `api_image`. Nothing here has been applied; the first real apply is the FD-7 rehearsal.

| Piece | What it is |
| --- | --- |
| Service | One Fargate task by default (`worker_desired_count`, 1 to 5; jobs wait in the database and two workers never run the same job), on the API's cluster, **no load balancer**, no shell (`enable_execute_command = false`), read-only filesystem **with no volume and no mount** (the worker writes no files: production worker code imports no file, operating-system or child-process module, a source test in `apps/worker/src/boundaries.test.ts` pins that, a real-process test runs it with `TMPDIR` and `HOME` pointing at nothing, and `worker.guard.test.mjs` fails if a volume or mount is added; unlike the API, whose intake stages uploads in `/tmp`), non-root, `stopTimeout` 60 s (longer than the 30 s drain), circuit breaker with rollback |
| Network | Its own security group: **no inbound traffic at all**, out only to the database (5432) and HTTPS. The health check is the container fetching `127.0.0.1:8081/livez` itself |
| Login | Secret `<name>/worker/database-url`, injected as `DATABASE_URL`. Written by `provision-logins` (login `telesphoros_job_worker`, member of `telesphoros_worker` **only**); Terraform creates the container, never a value |
| Task role | **Read-only on report files**: `s3:GetObject` and `s3:GetObjectVersion` on `reports/*` of the reports bucket, `kms:Decrypt` through S3 only. No put, delete, list, key creation, secrets or IAM right |
| Execution role | Pulls this repository, writes its own log group, reads **only the worker secret** |
| Logs | Own log group and own key (`/ecs/<name>-worker`), same retention floor as the API |

### Alarms (one email list: the audit topic)

| Alarm | Fires when | What to do |
| --- | --- | --- |
| `worker-job-dead` | a job logged `job-finished` with outcome `dead` | `jobs dead`, `jobs show`, fix the cause, then `jobs retry` |
| `worker-file-check-failed` | a stored-file check (`file-verified`, outcome not `ok`) or a daily re-check found a problem | Read the finding (see below). Nothing was repaired or deleted |
| `worker-queue-not-draining` | the oldest *ready* job has waited more than 15 minutes, two five-minute checks running | `jobs status`; look for workers down, stuck or too slow. A suspended organization's held jobs are **not** counted: they wait on purpose |
| `worker-heartbeat-stale` | no `queue-stats` line for five minutes (or no data) | The worker is stopped, crash-looping or cut off from the database. Nothing is lost: jobs wait |

The worker writes one `queue-stats` line a minute (`WORKER_STATS_SECONDS`, default 60: waiting count, running count, dead count and `ageSeconds`), which feeds the last two alarms. The patterns and the worker's own log literals are pinned by tests in both directions (`worker.guard.test.mjs`, `apps/worker/src/deploy-contract.test.ts`), so renaming a log field fails a build instead of silencing an alarm.

**A failed re-check.** `jobs dead` lists the job (`files.verify-stored` or `files.verify-stale`); `jobs show` gives its error code (`file-missing`, `file-changed`) and the `file_verifications` rows name the reason (`version-missing`, `size-mismatch`, `hash-mismatch`, `type-mismatch`). A missing version or different bytes in a versioned bucket that only the application writes means something happened to the file (a deletion, a lifecycle rule, a restore, tampering): treat it as an incident, not a retry. The job is retried only after the cause is understood.

### First deployment of the worker

1. Add the fourth secret to the provisioning run: `provision-logins` now creates `telesphoros_job_worker` and writes its secret (the provisioning task already names it). Run it **before migration 0023 and again after** (`--require-migrated`) as for the other logins; the second run reads the worker's privileges back and fails if it can read any table the queue's functions should guard.
2. Migrate (0023 to 0025).
3. Start the worker service. `worker-started` and `queue-stats` appear in its log group; the heartbeat alarm clears.

## Not yet

A Nest application context for handlers that write clinical records (the first such consumer is M3.x), a screen for the verification record, a notification channel other than the alarm email, and any real apply of this Terraform. The worker has never run in AWS: the Docker image build and the worker rehearsal mode (`infrastructure/docker/rehearsal-driver.cjs`) run in CI only.
