# M2.3: jobs, an outbox and an idempotent worker (plan)

Status: **approved by the founder on 2026-10-14 (DJ-1 to DJ-9: yes to all, recommendations as written). M2.3a is built on the local branch `claude/m2-3a-queue-core` (stacked on the M2.3 plan; not pushed).** Backlog T08 of the [build plan](repo-audit-and-build-plan.md); founder decision DA-5 (a separate `apps/worker` process sharing contracts with the API) is the starting point and DJ-1 makes it concrete. Synthetic data only; nothing here lifts the BAA or clinical hold; nothing is applied in AWS.

## Problem, as the repository stands after M2.2c

Everything asynchronous is either inline in a request or a person at a command line:

| Work | Today | Why it matters |
| --- | --- | --- |
| Capture and evaluation of a lab PDF | Inline in the request, as the signed-in person (the reader is slot-limited and answers 503 when busy) | The reader cannot be retried by anyone but the caller; extraction (M3.1) and the review journey (M3.2) need it to be a job |
| Abandoned upload attempts | An operator runs `uploads sweep` | Nothing runs it; quota stays held until someone does |
| Ledger verification | A timer inside every API process (`LedgerMonitor`) | Fine for now; it competes with requests and cannot be scaled or paused separately |
| Invitation to a Cognito account | An operator command; the API creates no account (DP-2) | M2.1a deferred this "to the M2.3 worker" |
| Safety notifications, knowledge withdrawal review (M3.3), knowledge releases (M2.4) | Do not exist | They need durable, retried, per-organization background work |
| What to do about work started for a person who is later removed or an organization that is suspended | Written down as "there are no jobs yet" (M1.5) | The rule has to be written the day the first job exists |

The repository has no queue, no scheduled work, no notion of a system actor, and no way for the API to say "when this commit succeeds, something else must happen" without a window in which one half happens and the other does not.

## Proposal in one paragraph

Add a **PostgreSQL-backed job queue and a transactional outbox**, and a **separate worker process** (`apps/worker`, same container image, its own ECS service, its own database login) that claims jobs with leases, runs registered handlers as a **system actor** inside the same per-organization transaction machinery the API uses, retries with backoff, and dead-letters what keeps failing. The API writes an outbox row **in the same transaction** as the change that needs follow-up; the worker relays outbox rows into jobs. Ship the platform plus two small real consumers that prove it end to end (a scheduled sweep of abandoned uploads, and a post-commit re-verification of every stored report file), and write the rules a later clinical handler must obey (it goes through `EvaluationsService` and the other services, as a system actor that can never satisfy an independence rule). No clinical behavior changes in this slice.

## Design

### Tables (one migration, 0023)

- **`jobs`**: `id`, `tenant_id` (null only for platform jobs; row-level security otherwise), `type`, `payload` (jsonb, a small fixed shape of ids and codes), `idempotency_key` (unique per tenant and type), `state` (`queued`, `running`, `succeeded`, `retry`, `dead`, `cancelled`), `run_after`, `attempts`, `max_attempts`, `lease_until`, `locked_by`, `requested_by` (a person's sub or `system:<source>`), `last_error_code` (a short code, never a message), timestamps. A claim is `UPDATE … WHERE state IN ('queued','retry') AND run_after <= now() … FOR UPDATE SKIP LOCKED` inside a `SECURITY DEFINER` function, because the worker must see every organization's queue while the application login sees only its own; the job then runs under the organization's own row-level security (`withTenant`).
- **`job_attempts`**: append-only record of each run (job, attempt number, worker id, start, duration, outcome code). No payload, no message.
- **`outbox_events`**: `seq`, `tenant_id`, `event_type`, `subject_id` (the report, evaluation or attempt it is about), `occurred_at`, `relayed_at`. Written by the API inside the business transaction (so a rolled-back change leaves no event, and a committed one cannot lose it); the relay marks `relayed_at` in the same transaction that inserts the jobs it fans out to (a static map from event type to job types, in code, reviewed like any other).
- **`job_schedules`**: the few recurring jobs (type, interval, last slot). The scheduler enqueues one job per slot using the slot in its idempotency key, so two workers cannot enqueue the same slot twice.
- Shape rules in the database, not only in code: payload keys come from a fixed list, string values match `^[A-Za-z0-9-]{1,64}$` (the same discipline as security events), size is capped, error codes are short codes. No filename, label, free text or patient value can be stored.

### Delivery semantics

At-least-once, with idempotent handlers. A claim takes a lease (default 5 minutes, renewed by a heartbeat while the handler runs); a worker that dies loses the lease and the job is claimable again. A failure schedules a retry with exponential backoff and jitter (1 min, 5, 25, …, at most 5 attempts); then the job is `dead`, kept, visible and never retried by the system. A handler that finds its work already done succeeds without doing it again. Exactly-once is not claimed anywhere. Per-organization fairness (a cap on concurrently running jobs per organization) and per-type concurrency limits keep one tenant or one slow type from starving the rest. Shutdown drains: a stop signal stops claiming, lets running jobs finish up to a bound, then releases the lease of what remains.

### Identity and the rules a handler lives by

- A job runs as organization work with a **system actor** (`system:<job type>`), recorded as `created_by` on whatever it writes (including ledger events). **A system actor never counts as a person for any rule that asks for one:** it cannot accept a capture, verify a patient link, decide a merge, or be the independent second person of any kind. A test pins this for each such rule.
- The rule M1.5 deferred: a job belongs to the organization, not to the person who caused it. Removing the person does not cancel it (the work is about the organization's records). **Suspending the organization pauses its jobs**: they are claimed but not run, and resume on activation (the same "suspended refuses on every request" posture, applied to the worker).
- **Handlers reach data only through the services the API uses** (the open item that `EvaluationsService`, `CapturesService` and the others are the only writers of clinical records). The worker is given those services, not repositories; a source-level test (as for `uploaded_at` and for evaluations) lists the modules a handler may import. **No handler in this slice writes a clinical record.**
- Payloads are ids and codes only (the database enforces it); logs name the job id, type, attempt and outcome code, never a payload value.

### The worker process

`apps/worker` is a thin shell: it boots a NestJS application context from the same modules (so services, tenancy and logging behave identically), starts the claim loop, the scheduler and the heartbeat, exposes a health probe, and has its own configuration (`WORKER_CONCURRENCY`, lease and backoff settings, job types enabled). Shared contracts (job type names, payload schemas, outbox event types, error codes) live in a new package `packages/jobs`, imported by both the API (to enqueue and to write outbox rows) and the worker (to run). A dependency guard keeps the worker from importing the API's controllers and the API from importing the worker's handlers.

### The first consumers (what proves it)

1. **`uploads.sweep`**, scheduled (hourly per organization): runs the existing `sweepTenantUploads` logic (closes abandoned attempts, returns quota, deletes nothing). The operator command stays for manual use.
2. **`files.verify-stored`**, from an outbox event written when a validated upload commits: re-reads the stored object **version** the report is pinned to, re-hashes it and compares size, type and SHA-256 with the report. The result is one append-only row in a new `file_verifications` table (`ok`, `missing`, `changed`) and a structured log line; a failure is a dead-letter-style alarm, not an automatic action. It also runs on a schedule over reports not checked for a long time (the integrity re-check the audit asked for, which today happens only when someone downloads).

Not in this slice: automating capture or evaluation (M3.1 and M3.2 decide who is accountable), creating Cognito accounts from invitations (a later consumer; needs AWS permissions and its own plan), notifications (M3.3), knowledge releases (M2.4), moving the ledger watch out of the API.

### Infrastructure and operations

Terraform (written, guard-tested, never applied, off by default like F3b): a worker task definition and ECS service (desired count 1), its roles (no more than the API's, plus none for AWS APIs the first consumers do not call), a log group with its own key, and alarms for a dead job, a worker heartbeat that went stale, and a queue that is not draining. Operator command `jobs list|show|retry|cancel|dead` (read mostly; `retry` re-queues one dead job, `cancel` stops one) and a runbook. A new database login `telesphoros_worker`, provisioned by the existing `provision-logins` command (FD-4a), with grants limited to the job tables and exactly what the two consumers need; widening it for a later handler is a migration and a decision, not a default.

## Slices (one pull request each, in this order, each stops for review)

| Slice | Content |
| --- | --- |
| **M2.3a** | Migration 0023 (jobs, attempts, schedules, claim and enqueue functions, the worker login and grants), `packages/jobs`, `apps/worker` (claim loop, leases, heartbeats, backoff, dead letters, scheduler, drain, health), the system-actor rules and their pinning tests, `jobs` operator command. Test jobs only (no real consumer yet). |
| **M2.3b** | The outbox (table, the API writing it in the commit transaction, the relay), `uploads.sweep` and `files.verify-stored` with `file_verifications`, the suspension rule end to end. |
| **M2.3c** | Terraform for the worker and its alarms, the runbook, CI wiring for the worker's tests and image target, STATUS. |

## What is touched

`apps/backend` (enqueue and outbox writes, the services the worker is given, the operator command, `provision-logins`), a new migration, new `packages/jobs` and `apps/worker`, `infrastructure/docker` (a worker target of the same image), `infrastructure/terraform` (written only), CI configuration (the worker's tests), docs.

## What this does not touch

The ledger's format, projections and event types; what a capture, evaluation, link decision, quarantine or merge means; roles and the membership model; the frontend; the reader and knowledge; real AWS (nothing applied); any clinical data or the BAA position.

## Decisions only the founder can make

| # | Question | Recommendation |
| --- | --- | --- |
| DJ-1 | Shape: a separate `apps/worker` process (DA-5), same image, own ECS service, contracts in `packages/jobs`? | **Yes.** One build and one set of services, but the worker scales, fails and is paused on its own, and an API task never runs a slow handler. |
| DJ-2 | Queue technology: PostgreSQL (`SKIP LOCKED`, leases) rather than SQS or Redis? | **PostgreSQL.** The outbox is only atomic with the business change if both live in one database, there is no new infrastructure to put under a BAA, and the volumes (reports per clinic) are small. Revisit if volume ever demands it. |
| DJ-3 | At-least-once delivery with idempotent handlers, five attempts with backoff, then a visible dead letter that only a person re-queues? | **Yes.** Exactly-once is not available; pretending otherwise hides duplicates. |
| DJ-4 | A system actor that never counts as a person for any independence rule, and handlers that write clinical records only through the existing services? | **Yes.** This is the rule that keeps a background job from becoming a way around two-person review. No handler writes a clinical record in this slice. |
| DJ-5 | Jobs belong to the organization: removing a person does not cancel them, suspending the organization pauses them? | **Yes** (closes the M1.5 deferral). |
| DJ-6 | Payloads of ids and codes only, enforced by the database; logs and errors carry codes, never values? | **Yes.** |
| DJ-7 | A separate worker database login with narrow grants, widened by an explicit migration per new consumer? | **Yes.** Least privilege; the cost is one migration per future handler, which is the point. |
| DJ-8 | The first consumers are the scheduled upload sweep and the post-commit file re-verification, and nothing clinical? | **Yes.** They are real, safe, and exercise scheduling, the outbox and retries without touching a clinical record. |
| DJ-9 | Operator command and runbook only, with no screen or API for jobs in this milestone? | **Yes.** A screen belongs to a later review-journey slice. |

## Verification (what each slice must show before it is called done)

- **Tiers:** in-memory (a queue test double for the API's unit tests), PostgreSQL, PostgreSQL plus S3 for the consumers, the recovery suites as an unprivileged user, browser suites unchanged and green.
- **Queue correctness (real PostgreSQL, two or more worker processes):** no job runs twice at the same time (race under load); a worker killed with SIGKILL mid-job loses its lease and the job completes elsewhere with exactly one durable effect; the same idempotency key enqueues once; backoff and the attempt cap behave; a poison job ends dead and is not retried; a stop signal drains running jobs and releases the rest; per-organization and per-type caps hold; a suspended organization's jobs are held and resume.
- **Outbox:** a rolled-back business change leaves no outbox row and no job; a committed one is relayed exactly once even if the relay crashes between steps; a crash between "insert jobs" and "mark relayed" cannot lose or duplicate (the same transaction).
- **Isolation and privilege:** a job for one organization cannot read or write another's rows (also with the worker's own login, whose grants are listed and tested for the absence of everything else); payload and error shape violations are refused by the database; no log line contains a payload value.
- **Rules:** a test per independence rule proves a system actor cannot satisfy it; a source-level test pins the modules a handler may import and that no clinical write exists in this slice.
- **Consumers:** the sweep closes exactly what the operator command closes; the verifier detects a missing version, a changed byte and a clean file, each with a control.
- **Defect injection** for every new rule (a claim without a lease, a lease not renewed, a retry without backoff, an outbox write outside the transaction, a payload shape check removed, a suspended organization's job run, a system actor counted as a person, a handler importing a repository), as in working agreement 6.

## Known limits to carry forward

- At-least-once means a handler that is not idempotent is a bug; the tests prove the two consumers are, not future ones.
- A single worker task is a single point of delay, not of loss (jobs wait in the database); alarms say when the queue is not draining. High availability of the worker is not claimed.
- The queue lives in the application's database: heavy job traffic competes with requests. Fine at these volumes; measured, not assumed, in M5.3.
- No AWS behavior is proven; Terraform is guard-tested only. The worker login, grants and alarms need the first real deployment to be proven.
- Cognito account creation from invitations and every clinical automation are deliberately later and need their own plans.

## M2.3a as built, and where it differs from the plan

Built: migration 0023, `packages/jobs`, `apps/worker`, the system-actor rules and their pins, and the `jobs` operator command ([runbook](../../ops/jobs.md), [verification](../../verification/m2-3a-queue-core.md)). Differences, each a decision for the founder to confirm or reverse:

- **`jobs.tenant_id` is NOT NULL.** The plan allowed a null for platform jobs. No platform job exists, and a null would have been a way around row-level security; the first one needs its own decision.
- **A suspended organization's jobs are held, not claimed** (the plan said "claimed but not run"). Claiming and not running is a state with nothing useful in it; not claiming means nothing changes until activation.
- **The worker is plain Node in this slice**, not a NestJS application context: it registers no job that needs a service. The Nest context (so a handler is given `EvaluationsService`, tenancy and logging as the API has them) arrives with the first consumer in M2.3b. Until then a source-level test lets a handler import only Node built-ins, `zod` and `@telesphoros/jobs`.
- **Two database roles instead of one.** `telesphoros_jobs` owns the tables and functions (a definer that cannot log in), and `telesphoros_worker` is the group the worker login joins. Both are created by the migration and listed with the other groups in `provision-logins`.
- **The worker login is not yet provisioned by `provision-logins`.** The command still creates three logins (application, verifier, migrator); adding a fourth needs a secret and its Terraform, which belong with the ECS service in M2.3c. Tests and the runbook use a login that is a member of `telesphoros_worker` only.
- **A claim's lease is one value per worker**: the shortest `leaseSeconds` among the job types it runs; the heartbeat renews it. A job type's own limit is its `timeoutSeconds`.
- **Operator commands do not take a free-text reason.** The history is append-only and shape-checked; the person's name is recorded, a reason is not.
- **System actors are refused at three more places than the plan listed**: the authentication layer (both token verifiers), the membership command, and `patient_identifiers.withdrawn_by`.
- **Found by testing and fixed in the slice:** `tenants` is under row-level security, so the definer role needs its own read policy to see which organizations are active (without it nothing was ever claimed); a claim that waited on another claimer's organization lock deadlocked; a capped organization's backlog hid everyone behind it; and a payload check in `jsonpath` lax mode let an array through.

## M2.3b as built, and where it differs from the plan

Built: migration 0024, the outbox and its relay, the two consumers (`uploads.sweep` and the stored-file re-check as `files.verify-stored` and the scheduled `files.verify-stale`), the `file_verifications` record, and the suspension rule end to end ([runbook](../../ops/jobs.md), [verification](../../verification/m2-3b-outbox-consumers.md)). Differences, each a decision for the founder to confirm or reverse:

- **No NestJS application context in the worker.** The plan had the worker boot Nest so a handler is given the API's services. Neither consumer writes a clinical record or needs a service, so the worker stays plain Node and reaches data only through **database functions that first prove the caller holds a running job of the right type** (`job_held`), then act for that job's organization alone. The Nest context, and the rule that a clinical handler goes through `EvaluationsService`, arrive with the first clinical consumer (M3.x). The worker login is still granted no table.
- **One implementation of the sweep, in the database.** `uploads_sweep` (owned by the queue's role) is what the scheduled job runs and what the operator command `uploads sweep` now runs. The application login can no longer run the sweep at all (a test in M2.2b had shown it could; that was incidental, not a feature).
- **The relay is a database function** (`outbox_relay`), not application code: events become jobs and are marked in one transaction, with the event-to-job map as a reviewed table (`outbox_routes`) instead of a map in code, so atomicity needs no two-phase protocol and a crash cannot lose or duplicate. The worker calls it every few seconds (`WORKER_RELAY_SECONDS`, default 5).
- **The outbox event has no foreign key to `tenants`.** The disposable local run and many tests write events for organizations that are not registered; the relay marks those events `no-organization` and creates nothing. A registered, suspended organization still gets its job; the claim holds it.
- **A failed re-check is a finding, not an action.** A missing version or changed bytes is recorded in `file_verifications` and ends the job **dead at once** (visible in `jobs dead`; an alarm in M2.3c); a read failure is recorded as `unreadable` and retried. Nothing is repaired, quarantined or deleted, and the report is not marked.
- **The scheduled re-check is its own job type** (`files.verify-stale`, daily per organization, at most 25 reports not checked for 30 days, never-checked first) instead of an unbounded sweep inside one job.
- **Leases:** the production types lease for 60 seconds with a heartbeat; their timeouts are 120 s (sweep), 300 s (one file) and 30 minutes (the daily re-check).
- **Terraform, alarms, the image target and the worker login in `provision-logins` are still M2.3c.** The stored-file re-check needs read access to the reports bucket for the worker; that IAM statement is written there.
- **Found by testing and fixed in the slice:** the first draft of the multi-process test depended on timing and on the per-organization cap; an empty bucket name was nearly accepted as "no bucket".
