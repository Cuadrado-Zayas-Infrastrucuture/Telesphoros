# Readiness database-drop timeout: cause and repair — 2026-11-18

`apps/backend/test/db/readiness.pg-spec.ts`, "turns NOT ready when the database disappears, without leaking why, and health stays 200",
has run past Jest's five-second deadline under load since PR 77 ([phase trace](readiness-phase-trace.md), 2026-10-26), most recently in
sealed sandbox jobs on 2026-11-12, 11-13, 11-17 and 11-18. Run alone it passes. The phase trace put the time in `database-drop`: 5.0 to
5.5 s on busy whole-file runs, 129 to 145 ms alone.

## Cause

`DROP DATABASE … WITH (FORCE)` ends the database's sessions, discards that database's buffers without writing them, and then requests an
immediate checkpoint and waits for it (the server logs `checkpoint starting: immediate force wait`). A checkpoint writes and syncs every
dirty page in the cluster. The file kept every test's application and database until `afterAll`, so at its first drop (this test, the
tenth of eleven) the checkpoint had to write the nine earlier tests' databases as well.

Measured on `origin/main` `591869af` in two 4-CPU sealed jobs at once (PostgreSQL 16.15, `shared_buffers` 128 MB, `fsync` on), the whole
file five times in each, with the server's checkpoint log and a 300 ms slow-statement log:

- 4 of 10 runs failed, each on this test's 5,000 ms deadline.
- This test's drop took 3,662 to 8,865 ms. Its checkpoint wrote 11,534 to 12,804 buffers (70 to 78 % of shared buffers) and synced 6,744
  to 7,582 files in 3.55 to 8.74 s: sync 3.44 to 8.55 s, write 0.08 to 0.24 s.
- The drop minus its checkpoint was 109 to 173 ms. Ending the dropped database's sessions (the application's pool) is not the cost, and the
  lock-wait test's connections belong to another database. The job's load average was 2.4 to 3.3 on 4 CPUs: the time is spent syncing
  files, not on CPU.
- In one job, every later drop's checkpoint wrote 0 to 41 buffers in 3 to 31 ms. When the last test's drop started while a timed-out
  test's checkpoint was still running, it waited for it (663 to 3,833 ms, three times).

Run alone, the test has no other live database, which is why it took about 130 ms.

## Repair

Fixture lifetime is bounded to one test, as [backup/restore](backup-restore-fixture-lifetime.md) did for the same mechanism: `afterEach`
closes the test's application and drops its database, `afterAll` retries that cleanup, and a `beforeEach` guard fails any test that
inherits live fixtures. A database dropped at the end of its own test has its pages discarded, so no later checkpoint writes them.
Assertions, the five-second deadline, the phase trace, the fixture helpers, production code and CI are unchanged.

## Evidence

- The same two-job setup on the fixed file, eight runs in each: 16 of 16 passed, and this test's drop took 111 to 123 ms. The largest of 88
  checkpoints in one job wrote 1,439 buffers and synced 846 files in 0.13 s (the first, which writes the freshly built template), and no
  drop there took 300 ms.
- A paired control in those jobs, the unchanged and the fixed file alternating, six of each per job (load average 0.5 to 1.6): unchanged
  drops 2,937 to 3,426 ms, fixed drops 113 to 123 ms. All 24 runs passed, because the host was quieter than during the failing runs.
- The guard: with `afterEach(releaseFixtures)` removed, 10 of 11 tests fail at the guard (expected 0, received 1); restored, 11 of 11 pass.

## Limits

This removes the accumulation inside this file. A checkpoint can still be slow when other work in the cluster leaves many dirty pages, and
the phase trace's own caveats still apply. Hosted CI remains the acceptance check on its runner.
