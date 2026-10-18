# Worker consumer job-settlement observation

## Cause

The [PR #166 CI worker step](https://github.com/Cuadrado-Zayas-Infrastrucuture/Telesphoros-Remastered/actions/runs/39156131959/job/117762211478)
failed in `worker-consumers.s3.test.ts`: verification rows existed with the expected
`ok` and `changed/hash-mismatch` results, but both jobs still read `running` when
the test expected `succeeded` and `dead/file-changed`.

The [file handler](../../apps/worker/src/handlers/files-verify.ts) records its
verification before returning or throwing. The [runner](../../apps/worker/src/runner.ts)
then settles the job with a separate database call. Visibility of the verification
row is not a completion signal for that later operation. The old process test
waited for the row, then performed one immediate job-state read. The adjacent
`consumers.s3.test.ts` already waits for job completion with the existing bounded
`until` helper.

## Repair and permanent regression

The process test now uses that same bounded-wait pattern for the two jobs belonging
to the exact synthetic reports and tenant. Both terminal assertions remain strict:
the correct file must succeed without an error, and the changed file must end dead
with `file-changed`. A cancelled job ends the observation but still fails those
assertions. Verification outcomes and log-redaction assertions remain.

`test/settlement-gate.ts` installs a static test-only trigger in the disposable
fixture database. It holds terminal updates behind a session-owned advisory lock;
the regression observes two actual PostgreSQL lock waiters after verification has
committed. It captures a real pair of `running` jobs, releases the gate only after
that snapshot, and requires a fresh observation of both correct terminal states.
Old completed jobs cannot satisfy the query because it filters the report IDs and
tenant. [PostgreSQL's lock view](https://www.postgresql.org/docs/16/view-pg-locks.html)
defines the lock-wait evidence used by the fixture.

The gate attempts lock release, both fixture-object drops and connection closure
even if an earlier cleanup step fails. It reuses `disposeFixtures` and
`onceFixtureCleanup` from the existing database test helpers. Setup and test errors
are preserved together with cleanup errors; repeated cleanup callers share one
disposal. A failed drop remains visible as a test failure, and the enclosing
fixture still drops its disposable database. Its DDL lock wait is bounded. It is not a migration,
runtime hook or change to worker/queue SQL, and never runs against AWS or an
existing database. No arbitrary sleep, CI retry, timeout increase or assertion
accepting unfinished work was added.

## Verification (2026-10-18)

| Check | Observed result |
| --- | --- |
| Original observer under the fixture gate | Native exit 1, original terminal assertion unchanged, same two `running` states as CI |
| Fixed process suite on real PostgreSQL 16/Moto | 4/4 passed |
| Premature-observation mutation | Returning the first snapshot instead of requiring terminal states fails the gated regression, native exit 1 |
| Restored process suite | 4/4 passed; source bytes restored after the mutation |
| Complete worker suite | 13 files / 126 tests passed, no skips or missing-service notices |
| Worker build, typecheck and lint | Native exit 0 |
| Owned-service cleanup after both runs | Moto exit 0, both ports closed, PostgreSQL PID removed; only `postgres`, `template0`, `template1` remain |

Local runtime pins: Node 22.22.0 and pnpm 10.28.0. Dependencies were installed
frozen/offline with lifecycle scripts disabled; no package or lock changes.
PostgreSQL durability settings remained on. Complete native stdout/stderr, exits,
red/mutation evidence and cleanup receipts are retained externally in the
originating Codex task under `work/worker-consumer-race/` and its `verification/`
directory. Earlier failed CI is preserved; no CI rerun or merge is part of this
local verification.

## Scope and remaining acceptance

Only the process test, test-only gate and its failure-path tests, and this
documentation/status record change.
Worker/queue runtime, migrations, permissions, provider configuration, CI coverage
and deadlines remain unchanged. PR #166 remains a separate documentation draft;
this fix is branched directly from main rather than stacked onto it.

Exact-head hosted CI is separate from these local results. No AWS access,
deployment, production database action, clinical acceptance or merge is authorized
by this repair. Later application of the reviewed fix to the documentation branch
and fresh CI acceptance remain separate delivery steps.

## PR #167 review: preserve failures during gate cleanup (2026-10-18)

One confirmed P2 finding affects failure diagnosis in the test fixture. In the
reviewed head `42dd2eef4285b6aa6f527aebb238ef08bd37a885`, a rejected trigger drop
skips the function drop, and a cleanup exception replaces an installation or
assertion error. This is separate from the terminal-state race repaired there.

Real PostgreSQL event triggers in fresh disposable fixture databases reproduce the
failure paths without modifying worker runtime or migration SQL. Against #167's
gate, the three lifecycle tests fail: only the cleanup error survives failed
installation; the function drop is skipped after a trigger-drop failure; concurrent
cleanup attempts unlock twice. The repair uses the existing helpers, includes
connection establishment in protected setup, and preserves the original assertion
through the process test's `finally` block.

The permanent tests require both construction errors, the original assertion plus
both drop errors, a disconnected gate session with no advisory lock, and one
successful disposal across repeated callers with both fixture objects removed.
Complete fault-injection stdout/stderr and native exit 1 are retained privately
under the originating task's `work/pr167-review/`; repaired results are in its
`verification/` directory. These tests exercise actual PostgreSQL failures, not
mocked query results.

| Review repair check | Observed result |
| --- | --- |
| Failure/lifecycle suite on reviewed #167 gate | 3/3 failed as expected, native exit 1 |
| Same suite on repaired gate | 3/3 passed |
| Complete worker suite including process regression | 14 files / 129 tests passed, no skips or missing-service notices |
| Worker build, typecheck and lint | Native exit 0 |
| Both owned-service runs | Moto exit 0, PostgreSQL PID removed, ports closed, only three standard databases remain |

The review branch starts directly at main
`f3a112fbafb5fc683747a511e11685a4dbe86c63`. It includes the original settlement wait
and this cleanup correction together, so it can be reviewed and integrated without
merging #167 first. The original #166 and #167 branches are preserved; none of
these local checks makes #166's failed historical CI green.
