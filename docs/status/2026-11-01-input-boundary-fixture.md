# Input-boundary fixture setup and cleanup
Date: 2026-11-01

The input-boundary API suite now prepares its disposable database separately from application startup, retaining Jest's default five-second budget for each hook and the existing test body. Teardown cancels the fixture scope and awaits the pending application before dropping its database, including when setup did not return an application.

The existing real-service lifecycle controls now cover this suite: combined setup latency must fit the separate hooks, while startup that exceeds its own hook must still fail and clean up without an undefined-app error or leaked database. Authentication precedence, input refusal, redaction and unchanged-record assertions are preserved. No production code, schema, frontend, dependency or CI gate changes.

[Reproduction and limits](../verification/input-boundary-fixture.md) records the CI failure and local evidence.
