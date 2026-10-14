# M2.3a the job queue, the worker and the system-actor rules: verification

Implementation on branch `claude/m2-3a-queue-core`, stacked on the M2.3 plan and every earlier unmerged M2.x branch (the founder asked on 2026-10-14 for this slice to be committed and pushed as a pull request, so the pull request carries that whole stack). Plan and decisions DJ-1 to DJ-9 (yes to all, 2026-10-14): [m2-3-jobs-outbox-worker.md](../design/plans/m2-3-jobs-outbox-worker.md), which records where the build differs. Results were captured locally on 2026-10-14; **no remote CI had run when this was written, so none of the required checks is claimed.** Synthetic data only; nothing applied in AWS. No job in this slice touches a clinical record.

## What was implemented

| Change | Where |
| --- | --- |
| Migration 0023: `jobs`, append-only `job_attempts`, `job_schedules`, `job_workers`; roles `telesphoros_jobs` (owner, definer) and `telesphoros_worker`; `job_enqueue`, `job_claim`, `job_heartbeat`, `job_succeed`, `job_fail`, `job_release`, `job_schedule_tick`, `job_worker_seen`, `job_stats`; forced row-level security; payload/error/key shape CHECKs; the definer's read policy on `tenants` | `apps/backend/migrations/0023_jobs.*.sql` |
| The human-actor rule: `<table>_created_by_human` on the eight human-decision tables (and `withdrawn_by` on patient identifiers), `tenant_memberships_sub_human`; both token verifiers and the membership command refuse `system:` | migration 0023, `auth/token-verifier.ts`, `membership/membership.ts` |
| `packages/jobs`: definitions, registry, flat-payload rule, error codes, backoff, system actor, queue client | `packages/jobs` |
| `apps/worker`: config, claim loop, leases and heartbeats, timeout, drain and release, scheduler, health endpoint, fixed-field logger, test-only job types; one self-contained bundle | `apps/worker` |
| Operator command `jobs status|list|dead|show|retry|cancel` | `apps/backend/src/jobs/jobs-cli.ts`, `db/cli.ts` |
| Plumbing: the new roles in `PRIVILEGE_GROUPS`, the migrator's membership of `telesphoros_jobs` in `provision-logins`, legacy required roles, table classification (`JOB_TABLES`), the CI step and its guard, `jobs` in the shared library build list | `src/db`, `.github`, `scripts/workspace-build` |
| Docs | the plan ("as built"), `ops/jobs.md`, `database.md`, `ops/membership.md`, STATUS |

## Tests added or changed

| Test | Proves |
| --- | --- |
| `apps/worker/test/queue.pg.test.ts` (25, real PostgreSQL) | Enqueue takes organization and person from the transaction; the same key returns the same job; payloads with text, nesting, arrays, null, long strings, bad keys or size are refused **by the database**; claim is oldest first, not before `run_after`, one claimer per job under 12 concurrent claimers; a locked job is passed over, not waited for; the per-organization cap holds across claimers and a capped backlog does not hide others; a suspended organization is held and resumes; only the holder can heartbeat, succeed, fail or release; an expired lease is reclaimed and recorded, and a job that keeps expiring ends dead; backoff is 1, 5, 25 minutes ±20% and agrees with the TypeScript formula; a fatal failure is dead at once; error codes that could carry text are refused; release does not count the attempt; scheduling is once per organization per slot however many ticks; the worker login can do nothing but call its functions and read its own organization's rows; the application login cannot claim or edit; the history is append-only for the owner |
| `apps/worker/test/runner.pg.test.ts` (11) | A job runs as the system actor; retry and dead letters carry their codes; an unexpected error's message reaches neither the database nor the log; a hung handler is abandoned at its timeout; an invalid payload is dead without running; a heartbeat keeps a job leased so a second worker never runs it; concurrency is never exceeded; drain finishes running jobs, and releases the rest without counting the attempt; the log has only the fixed fields |
| `apps/worker/test/processes.pg.test.ts` (7, real processes) | Three worker processes run 45 jobs with each run exactly once and the work shared; a worker killed with SIGKILL mid-job loses its lease, the job completes on another with **one** durable effect (it ran twice: at-least-once); SIGTERM drains and exits 0, or releases within a zero drain; the health endpoint; start-up refusals never echo a value; the log of a worker that ran a throwing job contains no value |
| `apps/worker/src/*.test.ts` (23) | Configuration refusals; the log drops any string that is not a short code; the runner against a fake queue; the health server; **source-level pins**: a handler may import only Node built-ins, `zod`, `@telesphoros/jobs` and the runner's types and names no clinical table; the worker takes exactly one file from the API (the TLS rule) and only `main.ts` opens a database connection; the API never imports the worker and registers no test-only job |
| `packages/jobs/src/jobs.test.ts` (13) | System-actor names, error codes, backoff, definitions, registry, flat payloads, queue client |
| `apps/backend/test/db/system-actor.pg-spec.ts` (11) | Each of the eight tables carries a validated CHECK refusing `system:` (and the withdrawal on patient identifiers); memberships refuse it, including by update |
| `apps/backend/test/db/jobs-cli.pg-spec.ts` (8) | The operator command reads and re-queues only what it should, records who, refuses malformed input, and works for a real non-superuser migration login holding the role by `SET` only |
| `auth` specs, `membership.e2e-spec.ts` | A correctly signed token whose subject is `system:...` is refused (both verifiers); a membership cannot be granted to one |
| `ledger-catalog`, `schema-acceptance`, `migrations`, `ledger-migration`, and the migration-list specs | The new tables are classified and protected as classified; the policies on `tenants` are exactly the application's and the definer's; constraints and keys are inventoried; every earlier migration-count expectation was updated |

## Defect injection

Each rule was broken on purpose by a script that edits the source or migration, runs the relevant suites and restores the file (`inject8.py`).

| Injected defect | Result |
| --- | --- |
| Expired leases are never reclaimed | 2 failed |
| Heartbeat or succeed does not check the holder | 1 and 2 failed |
| Retry without backoff | 4 failed |
| A release counts the attempt | 2 failed |
| Suspended organizations are claimed | 1 failed |
| Claim takes no row lock | survived at first; after adding the "passes over a locked job" test, 2 failed |
| Claim waits on another claimer's organization instead of skipping it | 22 failed (deadlocks) |
| Schedule slot not in the key; idempotency key ignored | 1 and 1 failed |
| Payload arrays pass (lax path mode); size cap removed; string shape removed | 1, 1, 1 failed |
| Error code shape not enforced | 1 failed |
| Worker may update jobs; application may claim; worker may read `patients` | 1, 24, 1 failed |
| Row-level security shows every organization | 2 failed |
| Attempt history can be edited | 1 failed |
| Enqueue without a person bound | 1 failed |
| The human check dropped from `corrections`, from memberships, from a withdrawal | 6, 6, 6 failed |
| A token may carry a system actor; a membership may be granted to one | 2 and 1 failed |
| No heartbeat; timeout not enforced; retry flag inverted; error message reported as code | 1, 2, 3, 2 failed |
| Shutdown does not release; a released job still reports; claims ignore free capacity; payload not validated | 2, 2, 1, 2 failed |
| The log writes any string; a handler imports `pg`; a handler runs SQL | 1, 2, 1 failed |
| **Survived, judged redundant:** the per-organization cap removed from the scan, or from the recheck (each alone) | each guard alone is covered by the other (the scan filter is an optimisation that spares lock attempts; the recheck is the authority). Removing both would fail the cap test |

## Faults found by testing, and fixed in the slice

The definer role could see no organization because `tenants` is under row-level security (nothing was ever claimed): it has its own read policy. A claim that waited for another claimer's organization lock deadlocked: it now skips. A capped organization's backlog hid everyone else's jobs behind it: candidates are chosen one at a time, with capped organizations left out. A payload check in `jsonpath` lax mode let an array through: strict mode. The schedule and worker tables carried an owner-only ACL that `pg_dump` does not write, so a restore compared unequal: they keep the default ACL. The real migration login could not be granted the new role when the groups are pre-created by `provision-logins`: it now grants the migrator `telesphoros_jobs` with the other two definer roles (**an existing deployment must run `provision-logins` before applying 0023**). A test of "work is shared" depended on timing and on the cap: it now enqueues after every process is polling.

## Local results

| Check | Result |
| --- | --- |
| Typecheck, lint, build (whole workspace) | pass |
| `test:infra`, `test:ci-config`, `test:image`, build-orchestration | 32, 36, 19, 8 passed |
| In-memory tier (`pnpm test`, no services) | pass (backend 1,392 passed; worker 23; jobs 13) |
| Backend on PostgreSQL uploading over S3 (Moto), 152 suites | 2,198 passed, 1 skipped, 0 failed |
| Recovery suites (backup/restore, recovery CLI, application and independent recovery, restore check, catalogue, off-site restore, ledger backup) run as an unprivileged user from a repository copy | 97 passed |
| Worker suites on PostgreSQL | 66 passed, repeated 5 times after the last change |

Not re-run (untouched by this slice): the browser suites and the frontend unit tests.

## What this does not show

- No remote CI has run; the new CI step is guard-tested but unexecuted.
- No production job exists: nothing here proves a real consumer, the outbox, or the worker inside the API's service container. The worker has never run on ECS, and no worker database login exists in any environment.
- Behavior under the network and under a real RDS, TLS to the database from the worker, and the cost of queue traffic on the application's database are not measured.
- One check is definition-based rather than behavioral: the eight human-decision tables' CHECKs are read from the catalog (their rows need a full ledger set-up) and exercised through the expression, not through an insert; memberships are exercised by insert.
