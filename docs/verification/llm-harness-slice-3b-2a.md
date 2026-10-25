# Verification: LLM harness slice 3b-2a (2026-10-25)

Scope: `apps/backend/{migrations/0049,src/db,test}`, `apps/ai-service/{src,durable,test}`, docs, `specs/003-llm-harness/tasks.md`.

## Environment

Node 22.22.0, PostgreSQL 16.15 (Homebrew tools first on PATH), `LC_ALL=en_US.UTF-8`, my own loopback cluster on port 54433 (SCRAM, `max_connections=200`), shared with no other session. `TEST_STORAGE=postgres`. The object-storage specs did not run.

## Order of work

The ports were made asynchronous and the request digest keyed first (the 311 existing ai-service tests passed unchanged apart from awaiting the doubles); the migration was written, then its spec; the adapter and its tests followed. The red evidence for the migration is the mutations below, not a pre-migration run.

## Checks

- `agentic-explain-runs.pg-spec.ts`: 35 tests pass (after the review fixes below). Real concurrency: 20 connections admitting one key give one new run and nineteen reports of it; 8 connections advancing from one state give one winner and seven stale.
- The transition truth table: SQL `agentic_explain_transition_ok` over all 121 pairs equals an independently written statement of the rule (31 legal pairs); a default-run test in ai-service reads the migration and compares the same list with `canTransition`, plus the eleven states, the 120-second deadline and (0048) the receipt reason codes with `FAILURE_REASONS`.
- `apps/ai-service` (default run): 23 files; async-failure tests (each of `admit`, `get`, `advance`, `reserve`, `begin`, `observe` rejecting ends the run held with the engine text), the keyed request digest, the adapter unit tests.
- Local-only, against my cluster: four tests run the real `runExplanation` on the real store (a release is `released` in the database with sequence 5 and the retry is a replay without a model call; a concurrent pair gives one release; a cancel while it works leaves the run cancelled at fence 2 and the work holds; an orphaned in-flight run is closed by the next admission of its key).
- Pins updated and passing together: schema-acceptance, tenant-capability (the 0031 revert), provision-logins (four new negative controls), ledger-catalog, migration-lint, the receipts spec, down-guards-as-migrator (a case for the runs table, run as the non-superuser migrator).
- One bug in my own test: the receipts spec's down test assumed 0048 was the top migration; with 0049 above it the first rejected call had already reverted 0049. It now reverts what sits above first.
- One equivalent mutant found and made observable: the "finished run is immutable" branch of the row guard was redundant with the move rule (no test could tell), so the test now asserts its message.

## Review by the schema session (read-only, 2026-10-25)

No blocker; label `breaking` confirmed; the 31 pairs, the lock order, the down migration and the operator functions' privileges confirmed. Fixed here:

| Finding | Fix |
|---|---|
| The deadline was not enforced where the compare-and-swap is | `advance` expires a run past its deadline and refuses `DEADLINE`; the database clock is the authority, the process clock a fast fail; `mono_at` documented as the admitting process's only |
| The sweep failed whole on a locked row and two sweeps could deadlock | `FOR UPDATE SKIP LOCKED` in one order; tested with a row held by another connection and two sweeps at once |
| A back-dated finish made a run deletable at once; an owner could insert an already-final run | The row trigger stamps `finished_at` itself on finish and forces every inserted run to start `admitted`, sequence 0, fence 1, now |
| `advance` could write `cancelled` (no fence) and `expired` early | Both refused (`cancel` raises the fence; the deadline decides expiry) |
| The hourly cap is soft | Kept, documented as acceptable for an abuse cap |
| Does the store treat a lock timeout as retryable? | Yes now: 55P03, 40001 and 40P01 become `RUN_STORE_BUSY`, shown in the receipt as a retryable cause |
| Requester scope differs from the receipts | Kept and documented why (a run is one person's request; a receipt is the organization's record) |
| `run_json`, `run_guard` and the receipt guard missing from the provisioning rights | Added as false for every login |
| The key of an expired run is burned for the retention period | Documented |

Not checked by the reviewer: it ran no test and read neither the tests nor the TypeScript store.

## Broken on purpose, first round (against the 30-test spec, 0049 restored after each)

| Mutation | Failing tests |
|---|---|
| The compare-and-swap check removed from `advance` | 3 |
| The row lock removed from `advance` | 1 |
| The requester filter removed from `get` | 1 |
| A transition added to the list (`admitted > running`) | 1 |
| Lazy expiry removed from `admit` | 1 |
| `ENABLE ALWAYS` removed from the row guard | 1 |
| The hourly cap switched off | 1 |
| `cancel` no longer raises the fence | 1 |
| The unique key removed | 11 |
| The finished-run freeze removed | 2 |
| In `explain.ts`: the request digest becomes a plain hash | 2 |

## Broken on purpose, after the review (against the 35-test spec)

| Mutation of `0049` | Failing tests |
|---|---|
| The deadline not enforced in `advance` | 1 |
| The sweep without `SKIP LOCKED` | 1 |
| The insert branch removed from the row guard | 15 |
| The finish time not stamped | 1 |
| `advance` allowed to write `cancelled` | 1 |

Restored after each; 35 passed again.

## Known limits

- The deadline is the database's (enforced in `advance`); the process also checks its own clock as a fast fail, so a skew between them can only make the process stop early, not extend a run.
- A run its process crashed on stays in flight until the next admission of its key or a sweep; nothing schedules the sweep or the purge.
- The hourly cap (1000) is an initial value, and the count is not locked, so concurrent admissions can overshoot slightly.
- Owner-level tampering (disabling or dropping the triggers or the table, back-dating a row) is not closable in a migration; `DROP TABLE` fires no row trigger, so `telesphoros.allow_runs_drop` is the only guard against it.
- The budgets are still the in-memory test double; the usage reservation and the caps are slice 3b-2b.
- Nothing in a running service uses the store yet. Hosted CI has not run.
