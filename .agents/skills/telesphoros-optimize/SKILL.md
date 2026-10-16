---
name: telesphoros-optimize
description: Measure and optimize Telesphoros performance, latency, slow database queries, deploy time or GitHub Actions costs. Profile the bottleneck and compare matched workloads before claiming speed or savings. Use for requests to shorten CI, reduce runner minutes or improve response time.
---

# Optimize a measured bottleneck

Read the [repository context](../../references/telesphoros.md) and relevant existing runbooks. Determine whether the wait is application latency, test/recovery work, build time or an actual deployment. Do not label a CI database job a production migration.

1. Establish a complete baseline: commit, workload/fixtures, runtime/runner, service setup, cache state, timings and all required acceptance evidence. For Actions cost, separate runner wall time, aggregate job minutes, per-job billing rounding, discounts/included usage and actual invoice charges. Verify the current account rate; do not freeze a historical rate into a savings promise.
2. Profile the producer and inspect real callers/history. Use bounded synthetic query/browser measurements; queries must retain tenant scope and run under the relevant role. Avoid logging query values or report content. Rank candidates by measured removable work, setup/transfer overhead, complexity and operational risk.
3. Propose a minimal change that retains the same workload, checks and evidence. Reuse existing dependency/build caches before adding mechanisms. A cache must invalidate for changed inputs, and tests/scans must execute now. Preserve required profiles, recovery evidence, durability and main-run cancellation.
4. Benchmark approved reversible changes on matched tasks. For caching, record cold and warm results, restore/save overhead and cache footprint. A same-commit hit is best-case; distinguish source-changing behavior and normal timing variation. Faster critical path does not imply fewer billed runner-minutes.
5. Reject weaker coverage as a saving. Shared-database parallelism can race restores/migrations/checkpoints; isolated runners duplicate setup and may cost more. Defer an operationally risky or unmeasured proposal. Paid benchmarks, quotas, cloud settings, new services or production work require a concrete founder decision before execution.

**Return:** `baseline | bottleneck evidence | candidate | matched result | cost basis | operational risk | keep/defer/reject`. Claim only measured improvements; identify inconclusive results. Keep production and test-environment conclusions separate.

**Self-check:** Is the evidence equal before/after? Did I count transfers and job rounding? Does the proposal preserve recovery guarantees and all required CI/security checks?
