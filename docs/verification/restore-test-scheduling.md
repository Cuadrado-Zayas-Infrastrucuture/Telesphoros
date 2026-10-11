# Restore-test scheduling verification

2026-10-11. Separate branch from main `8d4a852`; [plan](../design/plans/restore-test-scheduling.md).

## Failure and mechanism

PR #67 CI run [38143826385](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/actions/runs/38143826385) first failed in `backup-restore.pg-spec.ts:130` and `ledger-restore-check.pg-spec.ts:99`: both exceeded Jest's default 5,000 ms test-body deadline. An unchanged retry passed. No failed restore assertion was reported in that original run.

Jest previously derived its worker count from the host CPU count even when every worker shared one PostgreSQL service. The existing `serializeRestoreSuites()` advisory lock serializes participating restore suites only; unrelated database/API suites can still migrate, create/drop databases and issue queries concurrently. Under a controlled CPU constraint this competition saturated PostgreSQL and produced database and restore deadlines. Aggregate `pg_stat_activity` observations included `CheckpointStart`, `CheckpointDone`, `DataFileImmediateSync` and `DataFileExtend` waits. The restore-suite advisory wait is in a separately budgeted beforeAll hook, not the five-second test body that failed.

**Attribution limit:** the original runner did not capture PostgreSQL CPU/wait telemetry. The experiment establishes a reproducible shared-service contention mechanism and verifies its repair; it cannot prove the exact cause of those two historical delays or promise immunity to arbitrary runner starvation.

## Controlled experiments

All local data was synthetic. PostgreSQL 16 ran with normal durability settings. Temporary instrumentation recorded query categories and timings without SQL values, credentials or row contents. Node 22.22.0 matched CI. No test deadline was overridden.

| Environment and scheduling | Observed result |
| --- | --- |
| Native PostgreSQL, original two suites in isolation | 32 passed; original failing tests approximately 935 ms and 633 ms |
| Native PostgreSQL, database suites with four workers | 376 passed; one CREATE DATABASE call reached 1,373 ms |
| Linux PostgreSQL container, two CPUs, four workers | 376 passed |
| Same Linux container, 0.5 CPU, four workers | 375 passed, one five-second evaluation-context timeout; restore limit/control test reached 4,679 ms |
| Linux container, 0.25 CPU, four workers | `ledger-backup.pg-spec.ts:121` ownership/privilege restore refusal timed out at 5,000 ms; ledger-watch also failed; stopped the run after cascading cleanup/timer errors rather than counting it as completed |
| Fresh Linux container, same image and 0.25 CPU, configured single worker | **376 passed, 31 suites passed**, 123.976 seconds; zero enabled-test failures |

The single-worker control retained all assertions. The ownership/privilege refusal that failed under concurrent pressure passed in **1,864 ms**. The two original CI cases passed in **1,610 ms** (restore/cleanup) and **1,364 ms** (tampered-record refusal). Four suites / 57 tests were excluded by the existing local selection/environment: S3-dependent cases were not enabled in this isolated experiment, and the trust-authentication cluster did not prove password-authentication controls. This local experiment is not a claim that all CI service tiers passed.

## Repair and regression protection

`apps/backend/jest.config.js` now sets `maxWorkers: 1` only when `TEST_DATABASE_URL` is present. Unit-only execution retains Jest defaults. This serializes suites against the shared service; explicit multiple-session/writer operations within tests still execute concurrently. It changes no test discovery, assertion, five-second default deadline, retry policy, production recovery code or durability configuration. Existing longer test-specific budgets are also unchanged.

The CI configuration guard loads both configurations and verifies the service worker count, unchanged default timeout, common discovery pattern and inclusion of database specs. Mutation control: changing the worker count to four made this guard fail; restoring one made all **35 guards pass**. Backend lint passed. Application/type behavior is unchanged; no migration or clinical evaluation changes are involved.

## Full CI acceptance

All three existing service tiers, missing-service refusals, recovery-artifact validators, image rehearsal and remaining repository checks must still pass on the PR head. Their results are recorded in the PR after completion. No CI gate is bypassed. The local experiment does not prove production recovery performance or a clinical/deployment release.

Retention settings, object lifecycle rules, clinical gates and source-evidence links are untouched. Nothing is deployed or merged by this change.
