# /ready no longer rereads every migration file on each request (2026-10-24)

Date: 2026-10-24

**Implemented (no migration).** Foundation layer 9 (rate limiting), from the 2026-10-19 status. `GET /api/v1/ready` is public and is asked on every health probe and by anyone who finds it. Each call ran `migrationReadiness`, which ran `loadMigrations()`: a synchronous read of every migration file (72 files, 668 KB) and a SHA-256 of each pair, blocking the event loop every time. Now the shipped directory is read and hashed once per process (`shippedMigrations()` in `migrator.ts`); the answer still comes from the database on every call (pending versions follow the recorded history), and a directory a caller names is still read each time. The files of a running image cannot change (read-only root filesystem), so the cached answer cannot go stale.

**Tests, red first.** `migration-readiness.spec.ts`: after one warm-up call, 25 further calls read the migration directory 0 times (on the old code: 25 reads, red); pending versions follow a changing history; a history that disagrees with the files is still refused; a named directory is not cached (control: a directory that gains a file is read again). Two deliberate breakages (cache ignoring the directory argument, no cache) each turn a test red.

**Not done (separate).** `/ready` is still not rate limited, and the database probe itself is not cached (audit item 49 suggests about ten seconds); both are deliberate follow-ups, because caching the probe delays how fast a failing database takes a task out of service and needs a decision. The cost saved was never measured: it is reasoned from the code, not benchmarked.
