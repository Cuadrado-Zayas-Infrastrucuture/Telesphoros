# Fence rollout observation verification

Date: 2026-11-01. Base: `4de1324` on main. The helper is independent of unmerged PR #253; it does not modify the application or release/apply machinery.

The offline checker accepts complete synthetic ECS snapshots and returns a narrowly labelled observation, not a live fence/drain claim. Thirty-three focused tests passed in the supported native/subreaper context. They cover healthy consistent tasks, fully stopped old tasks, missing/enabled/duplicate/secret/file/override settings, mixed definitions/digests, unhealthy/pending/zero capacity, incomplete deployments, missing/extra/duplicate inventories, pagination/read failures, stale/future timestamps, malformed input and sanitized CLI exit/output. A sandbox-only attempt returned an uninformative file-level failure; the supported execution returned all test diagnostics and passes.

Removing the mixed-task-revision rejection made the old-running-task negative test fail; restoring it restored all 33 passes. The existing infrastructure test command imports these controls, so they run in its normal guard suite. No existing guard was weakened, and no live observations, AWS calls, provider behavior or drained requests are claimed. Fixtures are invented ECS observations; no outside service is mocked inside an application under test.

Local logs are under `/workspace/recovery/fence-rollout/`, not published evidence URLs. The complete repository checks are recorded below after completion.

## Repository verification

All six required local commands passed: typecheck, lint, workspace tests, build, infrastructure (248 tests, including the 33 new controls) and CI configuration (217). The frontend suite passed 682 tests. Backend memory tier: 2,076 passed / 449 skipped; five absent private-reader specs remain excluded. No assertion or required check was weakened.

No application, UI, schema, dependency or live infrastructure configuration changed. Browser, real PostgreSQL/S3, worker-service and FHIR tiers were not rerun for this offline helper; their skips are not passes. The independent application-fence PR #253 completed its own full hosted run 41351471109 and is ready for review/merge. That separate result does not establish a live rollout or request-drain observation for this checker. No services were started or left running for this work.
