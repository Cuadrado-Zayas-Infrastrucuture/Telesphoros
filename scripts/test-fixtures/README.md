# PostgreSQL fixture lifecycle regressions

Run `pnpm --filter @telesphoros/backend test:fixture-lifecycle` on Node 22.22.0 with
`TEST_DATABASE_URL` pointing at a disposable PostgreSQL 16 cluster. CI runs it in
service-postgres under the existing shared deadline, after the unchanged API profile.
No cloud services or real data are used.

The child processes run the actual intake, input-boundary and registration specifications. Controlled
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
The original specifications fail these controls; the corrected specifications
pass them. Fresh databases and buckets remain independent for every intake case.

The input-boundary suite uses the same split and late-delivery controls. Splitting
database preparation from API startup preserves both five-second hook limits. Its
cleanup awaits the pending application before dropping the database, including
when setup times out; it never assumes that an application has been returned.
All authentication, validation, redaction and unchanged-record assertions remain.

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

## Abandoned builds: the end-of-file drain

Jest does not cancel the async work a timed-out hook or test abandons. A fixture still being built then finishes with no owner (an application
starts listening, pools connect) and the single Jest process of the PostgreSQL tiers never exits (2026-10-17 and 2026-10-20: the step idled
until the run deadline). `createTestApp` and `createEphemeralDatabase` register each build and each live fixture in
`test/helpers/fixture-registry.ts`; `test/helpers/fixture-environment.cjs` (the Jest test environment) drains them at the end of every test
file, after the spec's own hooks and before the module registry is torn down: abort unfinished builds, wait for their own unwinding, close
what is left. It prints a `[fixture-drain]` line only when it had something to reclaim, so a clean run stays silent.

`test/helpers/fixture-drain.control.ts` holds three deliberately unprotected specs (`app`, `db`, `app-late`); `lifecycle.test.cjs` runs them as
children. Each fails its own test (status 1) and must exit by itself with its databases dropped. The same children with `--testEnvironment node`
must go wrong (the `app-late` child never exits, the `app` child leaves a database behind): that is the control that can go red. Breaking the
drain on purpose (no reclaim, builds not aborted, live fixtures not closed) fails these tests. The closing order (newest first) is not guarded.

`JEST_HANDLE_REPORT=1` prints what still holds the process after the run. `--detectOpenHandles` is no substitute: Jest skips TCP and TLS client
sockets (every pg and S3 connection). A connection a spec opens itself with `new Client` or `new Pool` is not registered; close it in the spec.
