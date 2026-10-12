# Backup/restore fixture lifetime

The remaining PR #73 database failure was the format-2 downgrade-refusal test exceeding its unchanged five-second deadline. The CI PostgreSQL log records a forced checkpoint from 23:47:56.242 to 23:48:01.109 UTC: 4.867 seconds, 9,318 buffers and 5,225 synced files. The failure was reported at 23:48:05. The CI log does not provide per-call timings, so it cannot attribute every millisecond to a specific TypeScript statement.

The suite retained all migrated source databases and backup directories until `afterAll`. Consecutive rejection cases return before creating/dropping a restore database, allowing dirty source fixtures to accumulate until a later successful restore triggers a cleanup checkpoint. The downgrade test contains that successful restore control after its rejection assertion.

A temporary numeric-only local probe reproduced the accumulation: 27 live source fixtures at the downgrade test, 30 by suite end. The original 26 tests passed locally in 15.388 seconds; the exact CI timeout was not reproduced on this machine. Evidence: [baseline measurements](/private/tmp/backup-timeout-baseline.log) and [CI log](/private/tmp/corrections-database-ci.log).

The fix bounds fixture lifetime to one test using `afterEach`, retaining `afterAll` as a cleanup fallback. Only databases and directories registered by this synthetic test suite are deleted; no production records, retention policies or clinical gates change. A `beforeEach` regression guard requires empty fixture registries. Restores still execute against real PostgreSQL with all original acceptance/refusal assertions, successful controls and five-second deadlines. No retries, skipped checks, relaxed authentication or durability settings are introduced.

Removing per-test cleanup makes the next selected test fail the new guard; restoring cleanup passes. Evidence: [initial fixed suite](/private/tmp/backup-timeout-fixed.log), [defect injection](/private/tmp/backup-timeout-mutation.log), and [backup/restore regression run](/private/tmp/backup-timeout-restored.log). All 85 tests across the five backup/restore/ledger/crypto suites passed. Backend typecheck and lint passed. The [final 26-test run](/private/tmp/backup-timeout-final.log) verifies numeric-only guard diagnostics. No instrumentation or numeric probe is shipped.

This removes the demonstrated cross-test fixture accumulation; it cannot promise a five-second deadline on arbitrarily slow storage. CI remains the acceptance check for the original runner. PRs #73 and #74 remain draft and unmodified.
