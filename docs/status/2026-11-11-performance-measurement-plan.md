# A plan to measure performance before changing it

Date: 2026-11-11

The founder asked to measure performance before deciding on improvements. [The plan](../design/plans/performance-measurement.md) is
proposed and not yet approved. Slices: read staging's existing request logs and metrics (founder-run, read-only); fix a replay race;
measure more routes locally with per-query database time; then, only if the founder decides to, per-query statistics and a short load
run on staging; and finally targets per route group.

While planning, the existing local rehearsal (`scripts/readiness/local-load.cjs`) was run 3 times, and a scratch probe of its replay check
15 more. 2 of the 18 runs failed: one of 16 simultaneous `POST /patients` with the same request id got `409 "A patient with that label
already exists."` instead of the replayed patient. The database still held one row. The cause is the label pre-check in
`PatientsService.create`, which runs before the repository's replay handling. It is not fixed here; it is slice 1, pending the founder's
decision D1.

Docs only. No code, test, migration, Terraform, CI or AWS change, and nothing in AWS was read.
