# Shared dependency build race

2026-10-11; `fix/shared-build-race` starts from main `db96b1e`. The source-PDF PR #71 is separate and is not included. See [approved plan](../design/plans/shared-build-race.md).

## Root cause and change

The first baseline `pnpm typecheck` attempt reproduced `ENOENT` unlinking `packages/shared-types/dist/index.cjs`. Backend and pilot pretypecheck hooks each launched a clean shared-types build from concurrent consumer tasks. Those nested writers are invisible to pnpm's outer dependency graph; they can remove another builder's output or files a consumer is reading. A build-only mutex would still permit cleaning after the first consumer starts.

The root launcher now builds shared-types, cpic-schema and fake-idp once before the typecheck/test consumer phase. Only that child invocation receives a prepared marker; the root always discards an inherited marker and rebuilds prerequisites. Package hooks skip their redundant dependency builds only in that prepared invocation. Recursive build needs no extra phase: pnpm's existing graph builds libraries before consumers and the hooks do not introduce hidden writers.

Actual consumer commands, package parallelism, tsup cleaning, test assertions and deadlines stay unchanged. Failures in preparation stop consumers; nonzero check exits, signals and spawn failures cannot report success. Standalone backend/pilot build, typecheck and pilot test still run their declared prerequisites. No new dependencies or lockfile change.

This coordinates one workspace invocation. Independent top-level commands in one checkout, or direct `pnpm -r` calls bypassing the launcher, are not coordinated; use the root `pnpm typecheck`, `pnpm test`, `pnpm build` commands and separate worktrees for simultaneous workflows. The change is not a general cross-process build lock.

## Verification

| Check | Evidence |
| --- | --- |
| Baseline | First normal parallel typecheck failed with the exact shared-types unlink race |
| Regression tests | Eight tests exercise prepare-before-consume ordering, one producer, standalone hooks, exit/signal/spawn failure propagation and inherited-marker refusal; they run in the normal `pnpm test` command |
| Typecheck | Three normal `pnpm typecheck` runs passed, including a cold run after moving only reproducible library outputs into a temporary backup. No concurrency override |
| Build | Two normal `pnpm build` runs passed with topological package parallelism. Each library was cleaned/built once per invocation |
| Workspace tests | Default workspace test run passed: 1,536 package tests plus eight orchestration tests. Its existing backend configuration explicitly excluded service tiers and reported 182 skipped tests; this is not full database/S3 acceptance |
| Standalone commands | Backend and pilot typecheck/build commands passed; their logs show prerequisite builds still execute |
| Prepared-child integration | Six existing stored-PGx tests passed against real PostgreSQL, signed fake-IDP HTTP and Moto S3 with the prepared marker, exercising the nested pilot build after the prerequisite phase |
| Defect injection | Removing the prepared marker caused three orchestration tests to detect unsafe nested builds. Source restored; all eight regression tests passed |
| Static checks | Workspace lint, 35 CI configuration guards and 19 image guards passed |

Local evidence (real workstation paths):

- [Baseline failure](/private/tmp/build-race-before-1.log)
- [Orchestration tests](/private/tmp/build-race-orchestration-final.log), [defect injection](/private/tmp/build-race-mutation.log)
- [Cold typecheck](/private/tmp/build-race-types-final-1.log), [warm typecheck](/private/tmp/build-race-types-final-3.log)
- [Topological build](/private/tmp/build-race-build-final-2.log)
- [Standalone backend typecheck](/private/tmp/build-race-standalone-backend-typecheck.log), [standalone pilot build](/private/tmp/build-race-standalone-smart-pilot-build.log)
- [Prepared-child PostgreSQL/API/S3 tests](/private/tmp/build-race-real-api.log)
- [Workspace tests](/private/tmp/build-race-workspace-test.log)
- [Lint](/private/tmp/build-race-lint.log), [CI guards](/private/tmp/build-race-ci-guard.log), [image guards](/private/tmp/build-race-image-guard.log)

Only build orchestration, its tests and documentation change. No clinical runtime, retention, infrastructure, migration, production data, deployment or check weakening. Repository-wide GitHub CI remains required before merge; local verification does not predeclare its result.
