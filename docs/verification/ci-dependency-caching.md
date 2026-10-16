# CI dependency caching — 2026-10-16

## Approved scope

Founder request: remove two unused Team seats separately in billing, and implement caching in one PR; preserve all required CI/security checks and leave main-run cancellation unchanged. The later request to evaluate database duration authorizes a feasibility review, with risky changes deferred.

Base: main `87ea5f6`. Changes: workflow cache inputs, Docker dependency-layer order, regression controls, and documentation. No application, schema, migration, clinical prompt/model, permission, required-check, cache quota or deployment change. The organization and plan remain in place. Main runs retain `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`.

## What changes

- Reuse setup-go's module/compiler cache; the explicit dependency input is `ci.yml`, which contains the gitleaks version. Keep `go install ...@v8.30.1` and the full-history scan unconditional.
- Derive Playwright's cache key from its installed package version, OS and architecture. Refuse malformed version metadata before writing the key. Keep browser system dependencies and browser/launcher tests.
- Fetch frozen pnpm dependencies from the reviewed lock/workspace inputs before copying source. Install offline from those inputs, then build and compare the deployment dependency graph as before.
- Import/export the image layers under one amd64-specific cache scope; bound waits, and ignore export errors only. Both OCI evidence and runtime exports, Trivy, and the synthetic rehearsal still run.

GitHub scopes PR caches to their merge ref; main cannot consume them. No credentials, test results or clinical payloads are added to caches. The storage limit remains unchanged; cache eviction and transfer overhead must be considered when measuring savings.

## Verification

Before the changes, the new cache controls fail because the proposed cache/version inputs are absent. The final local CI-config suite has 42 tests, including injected stale keys, optional scanning/installation, invalid Docker layer order and invalid version metadata. The actual version-extraction command is executed with positive and negative package fixtures.

Local results under Node 22.22.0: 42/42 CI-configuration tests and 23/23 Docker guard tests passed, with zero skips. The command also read the actual installed Playwright version (`1.64.0`). Actionlint's workflow/expression validation passes with shellcheck disabled; full actionlint reports the same pre-existing SC2034 unused loop-variable warning on both the unchanged baseline and this patch. The first Docker mutation run exposed that adding a frozen fetch could mask a missing frozen install; the guard now requires both, including offline installation, with separate defect controls.

Remote cold/warm verification and job timings will be added after the PR runs. Local Docker cannot run: the Docker daemon socket is absent. This document does not substitute text guards for a real image build or service-backed CI.

## Database duration feasibility — evaluated, deferred

The latest sampled successful database CI job took 1,727 seconds (28.8 minutes). The three profiles took 431, 552 and 598 seconds, followed by worker/evidence work. This is integration testing, not a deployed database migration. All three profiles and their recovery artifacts are intentional acceptance requirements.

| Option | Feasibility | Decision |
|---|---|---|
| Reuse an exact-checkout backend build inside this job | Three recovery suites currently build the backend in `beforeAll`, repeated in each profile. Potentially low risk if a freshness contract proves the artifact belongs to this checkout and local suites still build themselves. Step logs do not isolate compilation cost, so savings are unmeasured. | Defer to a separate, measured change. No build or assertion is removed here. |
| Run profiles on separate CI runners, each with its own PostgreSQL and Moto | Could shorten the critical path toward the longest profile plus setup and worker/evidence work. An estimate of roughly 12–15 minutes is conditional, not benchmarked. It needs an aggregate gate that fails on any missing/failed profile and preserves all evidence. It would duplicate setup and could increase billed minutes. | Technically feasible as a separate CI design; defer while reducing the bill. No production changes are required or proposed. |
| Parallelize suites against the current shared PostgreSQL instance | Existing worker serialization prevents oversubscription during migrations/restores/checkpoints. Removing it risks false failures and teardown races. | Defer; keep serialization. |
| Skip profiles, weaken restore deadlines/durability, or use cached green results | Would change what acceptance proves. | Reject. |

Operational risk stays low by leaving production, durability, migration behavior, real recovery checks and the current database job unchanged. The caching PR can improve supporting jobs but does not claim to solve the database critical path.
