# PostgreSQL fixture lifecycle regressions

Run `pnpm --filter @telesphoros/backend test:fixture-lifecycle` on Node 22.22.0 with
`TEST_DATABASE_URL` pointing at a disposable PostgreSQL 16 cluster. CI runs it in
service-postgres under the existing shared deadline, after the unchanged API profile.
No cloud services or real data are used.

The child processes run the actual intake and registration specifications. Controlled
latency makes the race repeatable without changing Jest's five-second hook/test
limits or PostgreSQL's two-second migration lock timeout:

- Slow database preparation plus slow API delivery each fit a hook, while their
  combined time exceeds a hook. Separating fixture phases must pass all API assertions.
- Delivery of an already-listening API takes longer than a hook. The hook must still
  fail, teardown must await the pending API and close it, and Jest must exit itself.
- A delayed lock-timeout response outlives the test. The test must fail while suite
  teardown waits for its finally block, without late imports or leaked databases.
- Slow database creation precedes real lock contention, rollback verification, retry,
  and full schema acceptance. Preparation must not consume the lock test's budget.

Every child must exit naturally within 25 seconds; hitting that outer bound fails the
regression. The late-hook child's failure is expected, never changed into a passing
application test. Complete child output is preserved in the parent output. Database
names before and after each child must match, proving no fixture database was leaked.
The original two specifications fail these controls; the corrected specifications
pass them. Fresh databases and buckets remain independent for every intake case.

The October 17 failure on main 95c6ead finished with two test failures, then Jest
remained alive until the existing CI deadline cancelled the process. Async Jest
timeouts do not cancel the underlying setup promise. Reading only the final
cancellation missed the earlier failures. Production application code and applied
migrations are unchanged by this repair.

## Scope and constructor failure controls

The follow-up keeps every original test/assertion and default timer. Each intake
case captures its own resource promises and cancellation signal before awaiting.
Late setup cannot publish its app/token into the next case; late teardown always
disposes its captured database. The cross-case control delays first setup 11.5s,
past both five-second hook windows, while the second case checks its database.
The first case remains failed and exits naturally; neither database remains.

The explicit `test/helpers/fixture-construction.control.ts` file is outside normal
profile discovery. It checks real migrator connect/migration rejection, compile
and bound-listener failure, cancellation after compile, concurrent idempotent
close, and retaining original plus cleanup errors. A pre-existing fixture remains
protected; owned database and session inventory must return to baseline. Constructors
unwind on failure even if the caller never receives a cleanup handle. Cancellation
fences prevent work starting after a scope ends; pending library operations must
still settle. The absolute service watchdog remains the final bound for an
operation that never settles; these controls do not claim a durable expiry receipt.
