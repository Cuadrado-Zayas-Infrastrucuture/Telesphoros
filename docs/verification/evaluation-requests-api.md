# H4 slice 1 verification: evaluation requests over HTTP

Date: 2026-10-27

Scope: [spec 006](../../specs/006-async-evaluation/spec.md) slice 1. Synthetic fixtures only (public D01 through the test stand-in reader); real restricted-role PostgreSQL 16 and an S3 emulator for the storage tier. Every run below is on the committed candidate with a clean tree, Node 22.22.0 and pnpm 10.28.0 from a frozen offline install.

## Seen failing first

Before any implementation, the new and changed tests failed for the expected reasons (15 of 115): the configuration tests (no such setting), the rewritten boundary test (the controller did not exist), the route inventory of the pipeline gate (two routes missing), and the new e2e suite (no such module).

## Meaningful failures and repairs

- The gate test enumerates controller prototypes, which evaluated a getter on the new controller and threw. The getter became a method; the gate test is unchanged.
- The first full loop failed one existing test in every backend tier: the hand-written inventory of production controllers and strict input pipes (`src/common/input-boundary.interceptor.spec.ts`) did not list the new controller. It now does (19 controllers), and every route of the new controller passes its undeclared-input refusal. Lint also found two files out of format. The whole loop was then rerun from the start on the amended candidate.
- The controller's own fallback answers 503 when the service is absent, so removing the gate guard would have gone unnoticed. The switched-off test now sends an invalid body and expects 503, not 400; the mutation that removes the guard is caught there.

## Results on the candidate

| Run | Result |
| --- | --- |
| install, typecheck, lint, `pnpm test`, build, demo seed, `knowledge:verify --production`, `test:infra`, `test:ci-config`, `check:workflows` | exit 0 |
| backend, in memory, with services | 2993 passed, 284 skipped |
| backend, PostgreSQL | 3256 passed, 21 skipped |
| backend, PostgreSQL and S3 | 3276 passed, 1 skipped |
| worker, with services | exit 0 |
| F2 and F3 recovery validators | exit 0 |
| Gitleaks on the commit | no leaks |

The new e2e suite runs only on PostgreSQL (the pipeline has no in-memory ledger); the skips are the existing ones, plus the five engine-only specs (ENGINE ABSENT).

## Mutations

Each was applied alone, its spec run, and the file restored byte for byte. All eleven were caught: the production refusal, the pipeline requirement and the profile check in configuration; the gate guard; the roles on admission (by the pipeline's route inventory, which requires every route to name its roles; the database would also refuse a reader); the start-up profile check; the service built while off (caught because the app then fails to start, not by the absence assertion); the consumer in `src/main.ts`; the consumer in `PRODUCTION_JOBS`; the worker named by an infrastructure file; the service named by another module.

## Not verified

- The routes were not called from a browser; the local review page is slice 3.
- The worker was run only in the test process, never as `start:evaluation-worker` against a full configuration, and never deployed.
- No hosted CI run yet.
