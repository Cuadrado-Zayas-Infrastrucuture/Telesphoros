# Isolated service profiles — local verification

**Historical initial candidate:** the `bd9b6cb` review subsequently reproduced incomplete action supervision and detached-child cleanup. The current local candidate and superseding deadline evidence are recorded in [service deadline supervision](ci-service-deadline-supervision.md). Results below describe the original capture; they do not establish the repaired hosted lifecycle.

Approved local slice, 2026-10-16. Branch `fix/ci-isolated-service-profiles` starts directly from main `7987a68c7825d05065215f26fa3f1724011d4bf6`. PR #146 remains an untouched draft at `9904bd1c3ff46ece562dfb4f8e5d7775966be190`. The existing prerequisite producer is carried byte-for-byte from that commit. No publication, hosted CI, rerun, merge, deployment or real-service profile execution is authorized by this record.

## Problem and implementation

PR #146’s run `38975579964`, attempt 1, exhausted the original 30-minute database job budget during Tier 3. Tier 1 and Tier 2 completed; Tier 3 lacked a final summary; worker and both hosted recovery-validator steps never ran. All nine emitted recovery aggregates passed offline validation, demonstrating why artifacts alone cannot establish whole-profile success. The earlier fresh-library producer worked but did not remove the sequential critical path.

Three independent jobs now run the exact existing backend pipelines on separate runner filesystems, PostgreSQL 16 clusters and Moto instances. Each keeps locked installation, PostgreSQL client/OpenSSL checks, fresh shared-library preparation, the existing test environment, native `pipefail`/skip refusal and seven-day evidence retention. The required `database-and-storage` name remains the joining gate; it explicitly refuses any failed, cancelled, skipped, absent or unexpected dependency, validates three complete current-attempt bundles, then runs the unchanged complete worker pipeline against fresh services. Both existing all-profile F2/F3 validators remain unchanged and mandatory.

Each job reads the current run attempt’s trusted `run_started_at`; the only accepted deadline is that time plus 30 minutes. The shared record binds repository, run ID, attempt, PR head and actual checkout. Initialization cannot overwrite a prior clock. All native service shell work consumes remaining time; timeout terminates the process group, escalates to KILL, and returns 124. Native failures preserve their exit codes. Final checks occur after artifact uploads. Queue/setup/transfer time consumes the same window; failure diagnostics and runner cleanup can finish later without establishing acceptance. Existing job caps and all test/hook timeouts remain unchanged.

A profile completion record requires a successful complete summary, unique passing suite records and counters, a successful prerequisite receipt, three fresh strict synthetic aggregates and their hashes. Intentional existing skips are recorded, while `NOT RUNNING` is refused. The gate downloads only current-run, current-attempt artifacts into separate directories, checks digest errors, verifies all bundles before copying, and refuses existing result files. Final acceptance revalidates bundles and copied bytes as well as worker completion. Earlier-attempt artifacts cannot satisfy a rerun; all three profiles must run again for a new attempt.

## Local evidence

Full permitted stdout, stderr and native producer exit receipts are retained in the chat’s external `work/isolated-service-profiles/` directory. Failed characterization and repair outputs remain alongside green results; no output was replaced by a summary-only record.

| Acceptance claim | Command/source | Result | Limit |
| --- | --- | --- | --- |
| Characterization detects missing isolation and deadline helper | Pinned Node, initial `service-isolation.test.mjs` | 2 failing cases before implementation, exit 1 | Local red evidence |
| All CI configuration controls | Node 22.22.0 / pnpm 10.28.0, `pnpm test:ci-config` | 71 passed, 0 failed/skipped, exit 0 | Local orchestration controls; no services |
| CI and existing workspace preparation controls | Pinned Node `--test .github/ci/*.test.mjs scripts/workspace-build/workspace.test.cjs` | 79 passed, 0 failed/skipped, exit 0 | Includes native child/pipeline failure, timeout, signal and descendant-cleanup tests |
| Workflow syntax and action expressions | `actionlint -color .github/workflows/ci.yml` | exit 0 | Does not execute GitHub’s scheduler or service containers |
| Defect controls | Three separate scratch copies: accept non-success dependencies; ignore expiration; swallow native failure | Each targeted test run failed with native exit 1; harness exit 0 | Unmodified working tree retained |
| Real output compatibility | Replay retained successful main job log | All 4 summaries accepted: backend suites 151/160/162 and worker 13; tests 2086/2318/2338/123 passed | Historical output, not new application execution |
| Aggregate schema compatibility | Replay all 9 retained PR #146 F1/F2/F3 artifacts | All accepted at their actual tested checkout | Original timed-out run still lacks complete Tier 3/worker acceptance |
| Clock API contract | Read-only GET of existing run `38975579964/attempts/1`, API version `2026-03-10` | Existing metadata reports attempt 1, correct repository/head, `run_started_at=2026-10-16T22:24:41Z`, exit 0 | Local `gh` authorization; hosted job token and scheduling remain untested |
| Scope preservation | Git/tree and exact pipeline comparison | Application trees equal main and `9904bd1`; all four pipeline bodies identical; six other jobs unchanged; producer and existing fixtures preserved | CI guards adapted to the new graph; application tests unchanged |
| Secret scan | Local `gitleaks dir --redact` using existing configuration | No leaks, exit 0 | Local working-tree scan; required hosted history scan remains mandatory |

The first actionlint pass caught a misplaced job environment; it was corrected before final acceptance. Guard repair preserved all three native backend pipeline controls, including the digit in `postgres-s3`. Original seven native preparation tests remain byte-identical; the two workflow preparation tests now cover each isolated profile rather than a monolithic job. F2/F3 fixture builders were moved verbatim into a shared fixture module; every original assertion remains.

## Preserved scope and remaining acceptance

No application source/test/configuration, discovery, worker count, test deadline, migration, schema, permission model, clinical behavior, model/prompt, package/lockfile, ruleset or deployment change. All six existing external required names, main-run cancellation and other CI jobs remain unchanged. Only the four service jobs add read-only `actions` permission for the attempt clock API; no writes or repository secrets are introduced. Artifact records contain fixed aggregate metadata, counters, hashes and repository test paths, with generic errors instead of environment/API serialization.

No runtime reduction is claimed. Historical timing supports trying isolation, but runner provisioning, queue time, transfers, isolated profile execution and the worker’s fresh-cluster execution require an explicitly authorized CI run. That run must prove all six required checks, all three complete backend profiles, the complete worker profile, all nine current-checkout aggregates and the joining gate within the shared 30-minute budget. Compare total service-path wall time from the attempt clock, including the joining job; the joining job’s displayed duration alone is not comparable to the old monolithic job. Aggregate runner minutes may increase. Do not raise the timeout, remove tests/profiles or reuse successful test results to obtain acceptance.

Session: `codex://threads/01a1468a-60c3-74a2-baa3-0ad59f19cf34`.
