---
name: telesphoros-debug
description: Diagnose Telesphoros failures, errors, broken tests, stale worker output or successful no-op runs. Reproduce a bug or regression, preserve producer evidence, isolate its root cause and add a regression control. Use when something stopped working or silently drifted despite a successful exit.
---

# Diagnose a failure before fixing it

Use the [repository context](../../references/telesphoros.md). Investigation is read-only until a fix falls within the approved scope. Preserve evidence before retries overwrite it.

1. **Reproduce:** Record the exact failing command/request, commit, runtime, service readiness and synthetic preconditions. Save complete permitted stdout/stderr and producer exit status before reducing output. Never reproduce using real patient data or print secret-bearing configuration.
2. **Localize:** Trace the producer through its callers and recent history. Compare passing/failing conditions with one variable changed. Check schema, application-role permissions, service availability, stale artifacts and environment drift. A green exit with skipped work is a failure to establish acceptance.
3. **Reduce:** Build the smallest synthetic case that preserves the defect. For background freshness, use the producer's own counter or a complete LastModified-sorted listing; an output tail or one page is not proof of the newest object. If reproduction is unavailable, return a bounded hypothesis and the missing evidence instead of a speculative fix.
4. **Fix:** Repair the reproduced cause inside the approved slice, using existing error/failure handling. Do not suppress an exception, extend a timeout, alter durability, skip a profile or refresh data merely to hide drift. Defer production-data changes and destructive remediation for a concrete blast-radius review and founder decision.
5. **Guard:** Run the regression case with the defect present and absent, including a valid success control for every refusal. Then run the affected real-service/browser suites. A same-cause failure repeated 2–3 times needs a blocker report and a changed hypothesis, not an unbounded retry loop.

**Return:** `symptom | reproducer | evidence | root cause or hypothesis | fix | regression result | unresolved acceptance`. If no cause was established, say so and list the next discriminating observation.

**Self-check:** Did the intervention fix the cause? Could a skipped tier, superuser test or truncated listing explain the apparent success? Does the positive control still work?
