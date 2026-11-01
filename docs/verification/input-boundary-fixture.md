# Input-boundary fixture setup

Date: 2026-11-01. Public Telesphoros; independent backend-test repair from main `7ff49849`.

## Observed failure

PR #238's [service-postgres-s3 job](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros/actions/runs/41314480899/job/124871836946) failed in `test/input-boundaries.e2e-spec.ts`: `beforeAll` exceeded 5,000ms while awaiting `createTestApp`, then `afterAll` tried to call `close` on the unassigned application. The tier reported 3,966 passed, one failed and one skipped test. The browser job passed. The original test setup is also present on main.

That helper creates the disposable database, creates/configures its S3 bucket and starts the real application graph in one hook. The hook's timeout does not cancel its async work. Cleanup held only the returned app rather than the in-flight promise. The existing global fixture drain eventually reclaimed the abandoned resources, but the suite still failed and cleanup obscured the setup failure with another error.

The retained offsite timing artifact does not include this suite. Its evidence cannot identify which individual database, S3 or application-startup call was slow on the hosted runner. The controlled reproduction below demonstrates the aggregate-budget defect without claiming a phase measurement from CI.

## Reproduction and repair

The unchanged test passed normally against a newly owned PostgreSQL 16 cluster and local S3 emulator. Applying the repository's existing `fixture-delay.cjs` split control reproduced both CI errors: 2.8s before real database creation plus 2.5s after real app startup exceed one hook, though each phase fits its own hook. Both new lifecycle controls failed before the repair.

The suite now follows the existing intake-fixture pattern: one hook prepares the database; another starts the application against that database. Both keep their default five-second limits. Cleanup cancels the scope, awaits the pending application and closes it, then drops the database in `finally`. The test body and all HTTP/refusal/redaction assertions remain byte-for-byte unchanged.

After repair, the normal test and split-delay control pass. An application deliberately delivered after its own five-second hook still produces the expected failing child test, exits naturally and avoids the undefined-app cleanup error. The lifecycle regression requires the child status to remain failed and checks that the database inventory is restored; it does not turn the timed-out application test into a pass. This adds two cases to the existing CI-run fixture lifecycle matrix without new helpers or CI changes.

## Verification and limits

Full command output and producer exit status remain in `/private/tmp/pr238-fixture-before`, `/private/tmp/pr238-fixture-controls-before`, `/private/tmp/pr238-fixture-after` and `/private/tmp/pr238-fixture-full`. Final project-gate results and the tested delivery commit are recorded in the PR and shared working notes. Expected negative-control failures are reported separately from passing application tests.

The service runner creates its own random-port PostgreSQL cluster and S3 emulator, uses restricted application roles and existing migrations, and shuts down only those owned services. No production database, real patient data or paid service is involved. The fault control adds latency around real helpers; it does not replace database, API or storage results. No production code, clinical logic, schema, authentication policy, frontend, dependency or check deadline changes.

This separates two bounded setup phases and safely owns late resources. It cannot guarantee either phase completes within five seconds on arbitrarily slow services. A repeat of the hosted job remains the check for that runner. The optional real-issuer profile, private reader engine, container image and human/device UI acceptance are outside this test-only repair. Codex produced the change and tests; no deployment is included.
