# Worker database limits and bounded shutdown (2026-10-23)

Date: 2026-10-23

**Implemented.** The worker's database pool had no connect, statement or idle-in-transaction limit (the API and the issuer have 2 s / 5 s / 10 s), and its stop sequence waited without limit on the tickers, the claim loop and the pool. The pool now has 2 s to connect, a 10 s statement limit (longer than the API's because the worker runs batch queries), a 10 s idle-in-transaction limit and a 12 s client-side `query_timeout`. The stop sequence (`apps/worker/src/shutdown.ts`) is bounded at drain + 15 s: past it the worker logs `shutdown-forced` and exits 1, before the container's 60 s `stopTimeout`. A step that throws is logged by name only and does not stop the later steps.

**Tests and controls.** Shutdown tests with hung fakes for each step; a PostgreSQL test (limits applied, statement cancelled with 57014, idle transaction ended, connect to a silent listener fails at about 2 s, a claim still works); a contract test that the deadline is below `stopTimeout`; two source pins that `main.ts` uses both. Nine injected defects turn them red. Full worker suite on the database and object-store tiers: 16 files, 189 tests.

**Not established.** The 10 s statement limit has not been measured against the longest real worker query on a production-sized database. No hung-database shutdown was run in a real process (the shutdown tests use fakes). Nothing observed in AWS; Terraform is unchanged.
