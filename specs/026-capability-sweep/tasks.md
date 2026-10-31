# Tasks: expired capabilities are removed, on a schedule, and someone hears when that stops

**Spec**: [spec.md](spec.md) · **Plan**: [plan.md](plan.md) · D1 to D5 approved as recommended (2026-10-31).

## PR A: database and worker

- [ ] T001 Test first: `test/db/capability-sweep.pg-spec.ts`, the plan's five cases, red before the migration exists.
- [ ] T002 Migration `00NN_capability_sweep_run.{up,down}.sql` (number re-read at build time): `capabilities_sweep_run(p_limit)` as in the plan.
- [ ] T003 `provision-logins.ts`: the function joins `WORKER_FUNCTIONS`; extend `test/db/provision-logins.pg-spec.ts` (allowed for the
  worker; a directly granted sweep is reported).
- [ ] T004 Test first: worker timer and settings tests (a line on every run including a run that removed 0, counts only, failure
  logged and survived, bounds refused); the tick's existing scheduler tests unchanged and green.
- [ ] T005 `apps/worker/src/scheduler.ts` (the log-every-run option), `config.ts`, `job-data.ts`, `main.ts`: the settings, the call, and the
  second timer.
- [ ] T006 `docs/ops/jobs.md`: the timer, its settings and its log lines. `docs/status/` note.
- [ ] T007 Confirm unchanged and green: `security-event-grace.pg-spec.ts`, `tenant-capability.pg-spec.ts`, `evaluation-requests.pg-spec.ts`.
- [ ] T008 Full local loop (every tier), then a PR when the founder says push.

## PR B: alarms

- [ ] T009 Test first: Terraform guard tests for the three alarms, with a break-it control each.
- [ ] T010 `infrastructure/terraform/worker.tf`: three metric filters and three alarms into the audit topic.
- [ ] T011 `docs/ops/jobs.md` alarms table and responses; `docs/ops/environments.md` in the PR that applies them.
- [ ] T012 `terraform fmt`, `validate`, `test`, tflint, `test:infra`; a PR when the founder says push.

## Release (founder)

- [ ] T013 Read the staging backlog once, read-only (D5); record it.
- [ ] T014 Release PR A's image; run the migration; read the first `capability-sweep-ran` lines until `behind` is false; record it.
- [ ] T015 Plan and apply PR B; fire each alarm once on purpose and see it return to OK (SC-002).
- [ ] T016 A day later, read SC-001 once, read-only; record it.
