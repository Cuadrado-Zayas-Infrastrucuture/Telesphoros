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
