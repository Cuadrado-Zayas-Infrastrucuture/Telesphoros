# Native database restore test timeouts — 2026-10-15

Separate fix from main `301b035`. The three affected test files are identical to those in PR #105 head `bb406cc`, whose [database job](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/actions/runs/38738770947/job/116434748835) reported eight five-second timeouts in `backup-restore`, `ledger-backup` and `ledger-restore-check`. The launcher/browser job passed. This change leaves PR #105's branch untouched.

## Cause and attribution

These tests run real migrations, native `pg_dump`/`pg_restore`, verification and database cleanup inside Jest's default five-second test/hook budget. A single test can perform three restores. CI's PostgreSQL log records a forced checkpoint completing at 13:02:38.001 UTC in **5.891 seconds** (13,348 buffers, 7,073 synced files); another completed at 13:08:01.420 UTC in **2.857 seconds**. A complete restore workflow cannot reliably fit a unit-test budget smaller than one of its I/O phases.

[PostgreSQL 16's implementation](https://github.com/postgres/postgres/blob/REL_16_STABLE/src/backend/commands/dbcommands.c) makes `DROP DATABASE` request an immediate, forced checkpoint and wait for it after clearing the database's pending synchronization requests. Cleanup is therefore part of the awaited restore's real I/O work.

The ledger suites also retained synthetic copies until suite end. A numeric-only local probe measured up to **eight live fixture databases** in ledger-chain tests and **three** in ledger-backup tests. Retained dirty copies make later checkpoints do unrelated fixture work. The earlier per-test cleanup fix already present in `backup-restore` does not address the other two suites or make storage latency fit five seconds.

The CI log has no per-call trace, so these observations do not assign every historical timeout to a specific checkpoint or prove the runner's exact CPU/storage state. The controlled experiment below reproduces the same premature test deadline with a real pending restore and shows why fixture cleanup alone cannot guarantee a five-second integration test.

## Controlled reproduction

Node 22.22.0 and PostgreSQL 16.14; synthetic data, fresh private clusters, normal durability. The harness refuses tests until startup succeeds and `SHOW data_directory` matches its owned cluster. Each run stops its owned server. Temporary tracing records phase durations and counts without SQL values, credentials or row contents; it is not shipped.

For the checkpoint control, the harness identifies the private server's checkpointer through `pg_stat_activity`, verifies its parent is the owned postmaster, and pauses only that process for six seconds during a real restore. An external resumer always releases it before shutdown. This models a checkpoint delay of the magnitude actually recorded in CI; it does not claim that CI's checkpointer was suspended.

| Experiment | Result |
| --- | --- |
| Unchanged three suites, no instrumentation | 37 passed; slowest case 4.081 seconds; total 33.808 seconds |
| Unchanged suites, phase/count probe | 37 passed; peak live databases 8 (ledger-chain), 3 (ledger-backup) |
| Original restore limit/control case, six-second checkpoint delay | Test body failed at 5.002 seconds; awaited restore continued for 6.144 seconds; teardown raced pending work |
| Original kept-restore case, same delay | Body passed, then the five-second cleanup hook failed |
| Repaired restore limit/control case, same delay | Passed at 7.101 seconds, including refusal and successful-control assertions |
| Repaired three suites, phase/count probe | 37 passed; peaks reduced to 2 and 2; total 29.045 seconds |
| Final repaired suites, no instrumentation | 37 passed, zero skipped; 27.044 seconds; zero residual fixture databases |
| Independent copies with either ledger per-test cleanup removed | Each first test passed; the next test failed its numeric empty-registry guard |

The selected single-case experiments exclude the other five cases; those exclusions are not counted as full-suite passes. Unchanged native baseline runs passed locally, so the historical CI timing itself was not reproduced without the controlled checkpoint delay.

## Repair and limits

- Give only these three native suites an explicit **30-second** test/hook budget. This covers multiple native restores plus the observed checkpoint delay while remaining bounded. Global unit defaults, explicit advisory-lock acquisition budgets and production recovery deadlines are unchanged.
- Release ledger-chain sources, kept targets and scratch directories after each test, with `afterAll` retrying registered cleanup.
- Release each ledger-backup test's targets and edited copies after each test. Preserve its shared source and baseline backup until suite end.
- Require empty per-test registries before the next case. Defect injection confirms removal of either cleanup hook is detected.

All original restore, chain-limit, tampering, ownership, privilege, snapshot and successful-control assertions remain. No retry, skipped assertion, relaxed durability, migration, application, authorization-policy or clinical behavior changes. The thirty-second budget cannot promise success under arbitrary service starvation. Full remote CI remains the acceptance gate and is recorded on the PR; no merge or deployment is authorized.

Backend typecheck and lint passed, as did all 36 CI configuration guards. The diagnostic harness, phase probes, checkpoint suspension and cleanup-removal source copies remain outside the repository diff.
