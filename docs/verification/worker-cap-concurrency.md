# Worker-cap concurrency test repair

The original cap test required two claims for each tenant immediately after one concurrent batch. That exceeds the documented fairness contract (`docs/ops/jobs.md`): a claimer skips a busy tenant advisory lock or candidate row, leaving work for the next poll. A candidate row skipped because its tenant is busy can remain locked until that transaction completes. The worker already polls again; this repair changes no runtime behavior.

## Assertions

`apps/worker/test/queue.pg.test.ts` now checks distinct properties:

1. After the concurrent round, returned IDs are unique, each tenant has at most two claims, and committed running-row counts match those claims.
2. Once all concurrent calls have settled, one serial follow-up claim must fill any remaining slots. Combined claims and database state must contain exactly two running jobs per tenant. Another claim must return empty.
3. Completing one tenant-A job must permit exactly one new tenant-A job, with a different ID. The database must still match the capped running set.

A second test forces contention through three explicit transactions on the existing restricted worker pool and six actual `JobQueue.claim` calls. One transaction holds tenant B's advisory lock while others skip it and retain candidate row locks. The test checks safety while those transactions are open, commits them, then requires the follow-up claim to fill the cap. It does not promise that every implementation must underfill the first round. All held clients are rolled back/released in `finally`, including assertion-failure paths.

## Local verification

Verified locally with Node 22.22.0, PostgreSQL 16.14 and requirements-pinned Moto 5.2.4:

- Queue suite: **27 passed**, no skips.
- Fifty bounded repetitions of the repaired concurrent-cap case: **50 passed**. The other 26 cases in that disposable copy were intentionally filtered out.
- Each of the four negative controls below failed at its intended assertion.
- Complete PostgreSQL/S3 worker suite: **123 passed across all 13 files**, with no skipped tests or `NOT RUNNING` service notices. The jobs package and worker bundle built successfully.
- Worker lint and type-check passed.

The repeated-case and mutation artifacts use copies of the candidate test file; the committed test file is unchanged during verification. These are local results, not a remote CI claim.

Four disposable test copies were expected to fail at specific assertions:

| Negative control | Mutation in disposable test copy | Required failure |
| --- | --- | --- |
| Over-cap result | Ask the real queue for cap three while keeping the test's expected cap two. | Three claims must fail the immediate at-most-two check. This checks the oracle; it does not change SQL enforcement. |
| Duplicate result | Append an already returned job to the observed batch. | ID uniqueness must fail. |
| Missing progress | Omit the settled follow-up claim from the forced-contention case. | Exact-two progress must fail when B still has one claim. |
| Old oracle | Restore exact-two checking before contention clears. | The valid one-job first-round result must fail that old expectation. |

The repeat/control copies are verification artifacts outside the commit. They do not weaken or condition the committed tests. No sleeps, retries, cap/lease adjustments, test-timeout increases, migration changes or CI-budget changes were introduced.

The full worker command builds the jobs package and worker bundle before running its tests. Local verification uses a fresh PostgreSQL cluster and fresh Moto process, synthetic fixtures and real restricted application/worker logins. Setup and assertion queries use the fixture admin connection; claims use the worker pool. The cluster and object-store process belong only to this verification run and are stopped afterward.

Remote required CI and release/hosted acceptance remain separate gates. No push, merge or deployment is part of this local repair.
