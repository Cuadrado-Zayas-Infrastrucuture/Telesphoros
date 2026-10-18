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

The gate always releases its lock, removes its fixture trigger/function and closes
its connection in cleanup. Its DDL lock wait is bounded. It is not a migration,
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

Only the process test, test-only gate and this documentation/status record change.
Worker/queue runtime, migrations, permissions, provider configuration, CI coverage
and deadlines remain unchanged. PR #166 remains a separate documentation draft;
this fix is branched directly from main rather than stacked onto it.

Exact-head hosted CI is separate from these local results. No AWS access,
deployment, production database action, clinical acceptance or merge is authorized
by this repair. Later application of the reviewed fix to the documentation branch
and fresh CI acceptance remain separate delivery steps.
