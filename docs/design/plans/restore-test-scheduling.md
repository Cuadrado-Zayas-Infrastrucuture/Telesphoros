# Restore-test scheduling investigation

Founder authorized investigation and a separate draft PR from main on 2026-10-11.

## Objective and scope

Reproduce five-second restore-test timeouts with real synthetic PostgreSQL, identify the resource contention mechanism, and repair test scheduling if the controlled comparison supports it. Preserve every assertion, service-tier requirement, default test deadline and production recovery behavior.

No retention values, lifecycle rules, clinical gates, production data, application schema or infrastructure configuration changes. No deployment or merge. The founder has already authorized this bounded fix; broader recovery behavior changes require separate scope.

## Method and acceptance

1. Profile unchanged restore suites in isolation and alongside the database suites. Record aggregate timing categories only.
2. Compare concurrent and sequential execution on the same CPU-constrained synthetic PostgreSQL container. The repaired scheduling must pass the previously failing controls without increasing timeouts.
3. Verify the scheduling contract and run the complete PostgreSQL/S3 tiers with their existing refusal and recovery-artifact checks.
4. Record original CI evidence, local limitations and final CI results. Leave the separate PR draft.

The original CI logs identify test-body timeouts but do not include PostgreSQL CPU/wait telemetry. A controlled reproduction can establish and repair a contention mechanism, but cannot retrospectively prove the exact resource state of that runner.
