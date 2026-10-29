# Verification: the database issues a job capability for an evaluation's requester (spec 012 slice 1)

Date: 2026-10-28

Scope: migration 0056, `tenant_capability_issue_for_job`. Synthetic organizations and people only. Real restricted logins (issuer, application, queue worker, restricted migrator) on owned PostgreSQL 16 (SCRAM), with Moto for the storage tier. Node 22.22.0 and pnpm 10.28.0 from a frozen offline install. Every run below is on the committed candidate `8ca279c` with a clean tree.

## Seen failing first

Before the migration existed, all 16 tests in `test/db/worker-capability.pg-spec.ts` failed: 15 because the function did not exist, and the grants test because the capability owner had no access to `jobs` or `evaluation_requests`.

The new migration also failed three existing catalogs until they were told about it, which is what they are for:

- `ledger-catalog.pg-spec.ts`: the job tables' policy list gains the capability owner's read policy.
- `backup-restore.pg-spec.ts`: the restored manifest has one more seeded row, the `evaluation-job` purpose.
- `tenant-capability.pg-spec.ts`: the 0031 revert names the new function and policies, and the `jobs` table's access list loses exactly the one new entry. Its second case failed only because the first had left the database reverted.

## Mutations

Each was applied alone, run against the spec it targets, and restored byte for byte.

| Mutation                                        | Result                         |
| ----------------------------------------------- | ------------------------------ |
| W1: the lease expiry is not checked             | caught                         |
| W2: any worker id is accepted                   | caught                         |
| W3: a job that is not running is accepted       | not distinguishable; see below |
| W4: any job type is accepted                    | caught                         |
| W5: the role is not checked                     | caught                         |
| W6: the application login may call the function | caught                         |
| W7: refusals are not logged                     | caught                         |
| W8: the down migration's guard removed          | caught by the down-guard case  |

**W3.** `jobs_running_shape` (migration 0023) ties a worker and a lease to the running state: a job has both exactly when it is running. So no row can hold the worker's lease without being running, and the state check cannot change an answer. A test that tried to build such a row was refused by that constraint. The state check stays in the function, with a comment, so it does not depend on the constraint.

Two checks are not mutated here because they live in the existing `tenant_capability_issue`, which this function calls: the requester's active, current membership, and the organization's status. The spec covers both through this function: a removed requester is refused as `membership-not-current`, and a suspended organization as `tenant-inactive`.

## Results on `8ca279c`

| Run                                                                                                                                                               | Result                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| install, typecheck, lint, `pnpm test`, build, demo seed, `knowledge:verify --production`, `test:infra`, `test:ci-config`, `check:workflows`, `test:launcher-cors` | exit 0                   |
| backend, in memory, with services                                                                                                                                 | 3076 passed, 358 skipped |
| backend, PostgreSQL                                                                                                                                               | 3413 passed, 21 skipped  |
| backend, PostgreSQL and S3                                                                                                                                        | 3433 passed, 1 skipped   |
| worker, with services; F2 and F3 recovery validators                                                                                                              | exit 0                   |
| browser, all three configurations                                                                                                                                 | 138, 30 and 2 passed     |
| Gitleaks on the commit                                                                                                                                            | no leaks                 |

The first browser run did not start: another session's browser suite held the fixed port 4010. It was left alone, and the run waited until the ports were free.

Before the push, the branch was rebased onto `main` `711c818`: the bounded evaluation-worker stop, the jobs package's shutdown limits, the palette, and spec 012 itself. No file is in common, and the newest migration on `main` is still 0055. On the rebased code: install, typecheck, lint, `pnpm test` and build exit 0; the new spec, the three catalogs, the down guards, the migrations spec and the migration lint pass on PostgreSQL (270 tests); `test/evaluation-worker-bounded.spec.ts` passes; gitleaks finds no leaks. `8ca279c` is the pre-rebase commit, kept under `refs/archive/` in a local checkout.

## Not verified

- Nothing calls the function yet. The issuer serves it in slice 2, and the worker uses it in slice 3.
- A lease that ends while a capability is being issued leaves a capability the worker cannot use, because every completion asks for the lease again (0051). No test races the two.
