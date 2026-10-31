# Feature Specification: expired capabilities are removed, on a schedule, and someone hears when that stops

**Feature Branch**: `docs/spec-026-capability-sweep` (spec only; the implementation gets its own branch off `main`)

**Created**: 2026-10-31

**Status**: Approved by the founder on 2026-10-31, D1 to D5 as recommended ([plan.md](plan.md)).

**Input**: found while reviewing Phase 0 of the production-stack evaluation (2026-10-30). Migration 0028 wrote the cleanup function and
deferred its caller: "The scheduled job that calls it is wired in slice 2, when capabilities are first minted outside tests"
(`0028_tenant_capability.up.sql:228-229`). Slice 2 shipped; the caller did not.

Line numbers cite `main` `1bfbdab4`. Migrations are never edited, so their line numbers hold.

## The problem

- **Capabilities are already minted outside tests, on every internal binding.** `tenant_capability_bind_internal()` inserts a
  `tenant_capabilities` row with purpose `internal` and a 60-second lifetime each time it is called (`0032:328-352`, lifetime
  `0032:355`). Five functions call it: two ledger-verifier paths (`0032:378`, `0032:410`), `job_held()` for every job the worker holds
  (`0032:437`), `uploads_sweep()` (`0032:461`), and the redaction path (`0032:507`). The worker and the ledger checks run in synthetic
  staging today ([environments.md](../../docs/ops/environments.md)), so rows are added there now: at least two per organization per hour
  from `uploads.sweep` alone (the job is held, then the sweep binds again), plus one per file verification and per ledger checkpoint.
- **Nothing removes them.** `tenant_capabilities_sweep(p_limit)` deletes rows that expired more than five minutes ago, at most
  `p_limit` per call (`0028:230-246`), and only `telesphoros_jobs` may run it (`0028:245-246`). No code, job, schedule or runbook calls it:
  a search of `apps/backend/src`, `apps/worker/src`, `packages`, `scripts` and `infrastructure` finds only the role maps in
  `apps/backend/src/db/provision-logins.ts`, which record that no login may call it. The tests run it once, as the owner
  (`test/db/tenant-capability.pg-spec.ts:320-339`).
- **So the table grows without bound.** In staging the size is small and unmeasured (D5). In production it grows with every job and every
  ledger check, and once the issuer is on (`enable_issuer`, off today: `infrastructure/terraform/issuer.tf:13`), with every request: each
  request mints a 60-second `request` capability (`0028:60-61`).
- **There is no global recurring job to hang it on.** `job_schedule_tick()` enqueues one job per active organization per slot
  (`0023_jobs.up.sql:302-307`), `jobs.tenant_id` is `NOT NULL` (`0023:43`), and `job_held()` binds the job's organization (`0032:425-442`).
  The sweep belongs to no organization.
- **Nothing would notice if a sweep stopped.** The worker's alarms watch the queue as a whole (`infrastructure/terraform/worker.tf`:
  heartbeat, not draining, dead jobs, schedule failures); none watches one recurring task going quiet.

**What does not need to change:** the five-minute retention, which spec 015 depends on (its grace window may not outlast it, and
`test/db/security-event-grace.pg-spec.ts:175-210` reads both from the live definitions); the capability rate limits, which count the
issuance log, not capability rows (`0028:142-145`); and the expiry index the sweep already uses (`tenant_capabilities_expiry_idx`,
`0028:78`). No foreign key references `tenant_capabilities`.

## User scenarios

### US1: the table stays bounded (P1)

As the operator, I want expired capabilities removed continuously, so the table holds roughly the last few minutes of capabilities, not
every capability ever minted.

**Acceptance:**
1. With the worker running, a capability that expired more than five minutes ago is gone within one sweep interval plus one tick.
2. A capability that is live, or expired less than five minutes ago, is never removed.
3. A backlog larger than one batch drains over successive runs, and the run says so while it is draining.

### US2: a stopped sweep reaches a human (P1)

As the operator, I want an alarm when the sweep fails, stops running, or falls behind, so the table cannot grow quietly for months.

**Acceptance:**
1. A sweep that raises an error is logged at `error` and counted; repeated failures raise an alarm.
2. A sweep that has not run for 15 minutes raises an alarm, including when the worker logs nothing at all.
3. A sweep that has stayed behind for 30 minutes raises an alarm.

## Requirements

- **FR-001 (the caller):** One new `SECURITY DEFINER` function, owned by `telesphoros_jobs`, calls `tenant_capabilities_sweep(p_limit)` and
  returns the number removed and whether rows past the retention remain. Only the worker login may execute it, and
  `provision-logins.ts` and its checks say so. `tenant_capabilities_sweep` itself is not changed; its text is what spec 015's guard reads.
- **FR-002 (the schedule):** The worker runs it on its own timer, separate from `job_schedule_tick()`, every `WORKER_CAPABILITY_SWEEP_SECONDS`
  (D2) with a batch of `WORKER_CAPABILITY_SWEEP_LIMIT` (D2). Every worker task runs one; concurrent runs are safe because a row
  another run deleted is simply skipped.
- **FR-003 (the record):** Each run logs one line, `capability-sweep-ran`, with the number removed and the backlog flag only (no tokens,
  organizations or people), and a failure logs `capability-sweep-failed` at `error`.
- **FR-004 (the alarms):** Three CloudWatch alarms into the audit topic, as the worker's other alarms: failing, stale (missing data counts as
  a breach), and behind (D4).
- **FR-005 (the first run):** The first run in an environment removes the whole backlog at one batch per interval. Before the release, the
  backlog's size is read once from the environment, read-only (D5), and recorded.
- **FR-006 (retention unchanged):** The retention stays five minutes, so spec 015's grace guard keeps passing unchanged (D3).

## Out of scope

- The issuance log's own retention (it is what the rate limits count; it grows too, and gets its own decision).
- Turning the issuer on, or changing any capability lifetime.
- A general mechanism for global recurring jobs in the queue (D1 explains why this spec does not build one).
- Any change to `tenant_capabilities_sweep`, `job_schedule_tick`, `job_held` or the jobs table.

## Success criteria

- **SC-001:** In synthetic staging, a day after release, no row in `tenant_capabilities` expired more than one interval plus five minutes ago,
  read once, read-only.
- **SC-002:** Each alarm has been seen to fire once on purpose in staging (stop the timer by configuration; make the function fail), then
  return to OK.
- **SC-003:** Spec 015's grace guard and the existing capability tests pass unchanged.
