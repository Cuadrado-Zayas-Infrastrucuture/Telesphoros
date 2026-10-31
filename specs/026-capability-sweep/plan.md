# Implementation Plan: expired capabilities are removed, on a schedule, and someone hears when that stops

**Spec**: [spec.md](spec.md)

**Status**: Approved by the founder on 2026-10-31, D1 to D5 as recommended: a worker timer calling a new definer, every 60 s and 1000
rows, the five-minute retention kept, three alarms, and the staging backlog read once before the release.

## Summary

One migration adds a worker-callable definer, `capabilities_sweep_run(p_limit)`, that calls the existing
`tenant_capabilities_sweep(p_limit)` and reports whether a backlog remains. The worker calls it on its own timer, as it already does for
the recurring-job tick, and logs one counts-only line per run. Three CloudWatch alarms watch those lines. Nothing about the sweep's
retention, the jobs table or the recurring-job tick changes.

## Technical Context

- PostgreSQL 16, row-level security, `tenant_binding_mode` `dual`.
- `tenant_capabilities_sweep(p_limit)`: owner `telesphoros_capability`, executable by `telesphoros_jobs` only (`0028:230-246`). It uses
  `tenant_capabilities_expiry_idx` (`0028:78`) for `ORDER BY expires_at LIMIT`.
- The worker already runs a timer per task for the tick: `Ticker` (`apps/worker/src/scheduler.ts:11-46`, started in `apps/worker/src/main.ts`),
  logging `schedule-ran` (only when it enqueued something) and `schedule-failed`, with an interval from `apps/worker/src/config.ts:20`
  (`WORKER_SCHEDULE_TICK_SECONDS`, 5 to 3600, default 30).
- What the worker login may execute is listed in `apps/backend/src/db/provision-logins.ts` (`WORKER_FUNCTIONS`, and `CAPABILITY_RIGHTS` for
  the sweep itself) and checked against the live database (`test/db/provision-logins.pg-spec.ts`).
- Alarms: `infrastructure/terraform/worker.tf` defines the worker's metric filters and alarms into the audit topic (for example
  `worker-schedule-failing`, from `schedule-failed`).

## Constitution Check

- Synthetic data only. The sweep reads and deletes capability rows; it logs counts only.
- One migration with a down file, run as the non-superuser migrator. No existing function is redefined.
- Fail closed: a run that cannot complete removes nothing more than it committed, logs the failure, and the alarm says so.

## Decisions for the founder

| | Question | Options | Recommendation |
|---|---|---|---|
| **D1** | What runs the sweep, given that a recurring job always belongs to one organization? | **(a)** A worker timer calling a new definer, beside the tick (no job row). **(b)** Call the sweep from inside `job_schedule_tick()`. **(c)** A reserved "system" organization so a recurring job can carry it. **(d)** Let `jobs.tenant_id` be null. | **(a).** It touches no shared table. (b) would make the sweep's failure abort the tick's transaction, so every recurring job stops with it, and its log line could not be told apart. (c) puts a fake organization into every per-organization query and policy. (d) breaks the queue's idempotency key (`UNIQUE (tenant_id, type, idempotency_key)` treats nulls as distinct) and every policy written for `tenant_id`. |
| **D2** | How often, and how much per run? | Interval 30 to 3600 s; batch 1 to 10000. | **Every 60 s, 1000 rows.** That clears up to 1.44 million rows a day per worker task, far above any rate staging or a first production tenant mints, and one indexed delete per minute is negligible. Both are worker settings with bounds, like the tick's. |
| **D3** | Keep the five-minute retention? | Keep; or change it in a new definition. | **Keep.** Spec 015's grace window is bounded by it, and its guard reads both from the live definitions. There is no reason to hold internal capabilities longer: nothing reads one after its grace. |
| **D4** | Which alarms, and on what? | Failing; stale; behind. | **All three, into the audit topic.** **Failing:** `capability-sweep-failed` ≥ 1 in 2 of 2 five-minute periods, like `worker-schedule-failing`. **Stale:** `capability-sweep-ran` < 1 in a 15-minute period, missing data breaching, so a worker that logs nothing at all also alarms. **Behind:** a run reporting a backlog, in all of 6 five-minute periods (30 minutes). |
| **D5** | Measure the backlog before the first run? | Measure once, read-only; or just release. | **Measure once.** One read-only query on staging before the release (`count(*)`, `min(expires_at)` of rows expired more than five minutes ago), recorded in the release's status note. It shows how long the first drain takes and gives SC-001 a baseline. The query runs as the founder, the same way other staging database reads are run, and is not automated. |

## Design (assuming D1 (a) and the recommendations)

### The migration (next free number at build time; 0065 on `main` today)

- `capabilities_sweep_run(p_limit integer) RETURNS TABLE (removed integer, behind boolean)`, `SECURITY DEFINER`, `SET search_path =
  pg_catalog, pg_temp`, owned by `telesphoros_jobs`:
  - refuses `p_limit` outside 1 to 10000 (`invalid_parameter_value`);
  - `removed := public.tenant_capabilities_sweep(p_limit)`;
  - `behind := EXISTS (... WHERE expires_at < clock_timestamp() - interval '5 minutes')`, after the delete, on the same index.
- `REVOKE ALL ... FROM PUBLIC`, `GRANT EXECUTE ... TO telesphoros_worker`.
- The down file drops the function.
- `-- compat: additive`.

### The worker

- `apps/worker/src/config.ts`: `WORKER_CAPABILITY_SWEEP_SECONDS` (default 60, 30 to 3600) and `WORKER_CAPABILITY_SWEEP_LIMIT` (default
  1000, 1 to 10000), with the same parsing and bounds as the tick's setting.
- `apps/worker/src/main.ts`: a second timer named `capability-sweep`, started and stopped with the tick's. It logs
  `capability-sweep-ran` `{ removed, behind }` at `info` on **every** run, and `capability-sweep-failed` at `error`.
- The existing `Ticker` cannot carry this unchanged: it logs `${name}-ran` only when the run returned more than 0, and only `{ count }`
  (`apps/worker/src/scheduler.ts:29-38`). A quiet minute would log nothing and the stale alarm would fire on an empty table. So `Ticker`
  gains an option to log every run with the run's own fields; the tick keeps its current behaviour, and its existing tests stay unchanged.
- The data call lives beside the others in `apps/worker/src/job-data.ts`: `SELECT * FROM capabilities_sweep_run($1)`.

### The roles

- `provision-logins.ts`: `capabilities_sweep_run` joins `WORKER_FUNCTIONS`. `CAPABILITY_RIGHTS` still gives no login the sweep itself.

### The alarms (infrastructure, its own pull request)

- `worker.tf`: three metric filters on the worker's log group (`CapabilitySweepRuns`, `CapabilitySweepFailures`,
  `CapabilitySweepBehind`) and three alarms (`worker-capability-sweep-failing`, `-stale`, `-behind`), named and wired as the existing ones.
- `docs/ops/jobs.md`: the alarms table and what to do for each.
- `docs/ops/environments.md`: updated in the same PR that applies them.

## Delivery

1. **PR A: database and worker.** The migration, the worker timer, the role maps, and their tests. It runs every tier.
2. **PR B: alarms.** `worker.tf` and the runbook, with the Terraform guard tests. Planned and applied by the founder after PR A's image is
   released, so the stale alarm does not fire before the sweep exists.
3. **Release (founder):** measure the backlog (D5), release the image, run the migration, then apply PR B. Read the first runs'
   `capability-sweep-ran` lines and record when `behind` turns false.

## Tests

- **`test/db/capability-sweep.pg-spec.ts`** (new):
  - as the worker login, an expired-for-an-hour row is removed;
  - a live row and a row expired one minute ago are kept;
  - a batch of 3 over 5 old rows reports `behind` true, then false on the next call;
  - a limit of 0 or 10001 is refused;
  - the app, verifier, issuer and migrator logins are refused with 42501.
- **`test/db/provision-logins.pg-spec.ts`:** the worker may run the new function; a worker granted the sweep directly is refused by the check.
- **`apps/worker`:**
  - the timer runs on its interval and logs counts only;
  - a failing call logs `capability-sweep-failed` and the timer keeps running;
  - the settings refuse out-of-range values.
- **Unchanged and still green:** `security-event-grace.pg-spec.ts` (the retention guard), `tenant-capability.pg-spec.ts` (the sweep's own
  behaviour and its 42501 list), `evaluation-requests.pg-spec.ts` (the production job list, which gains no type).
- **Terraform (PR B):** the guard tests pin the three alarms' metric, threshold, period, missing-data treatment and topic. Each has a
  break-it control.
