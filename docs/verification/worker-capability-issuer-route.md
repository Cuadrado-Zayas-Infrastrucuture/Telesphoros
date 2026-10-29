# Verification: the session issuer serves job capabilities to a signed worker (spec 012 slice 2)

Date: 2026-10-29

Scope:

- `worker-signature.ts`, the `POST /v1/job-capabilities` route, `JobIssuerCore`, the `ISSUER_WORKER_KEY` setting, and migration 0057 (the shared nonce store).
- Synthetic data only.
- Real issuer processes (`startIssuer`) and real restricted logins on owned PostgreSQL 16 (SCRAM), with Moto for the storage tier.
- Node 22.22.0 and pnpm 10.28.0 from a frozen offline install.
- Every run below is on a committed candidate with a clean tree.
- Test keys are generated per run and never written down.

## Seen failing first

Before the code existed:

- the signature spec could not load its module;
- the four new `ISSUER_WORKER_KEY` cases in `issuer-env.spec.ts` failed;
- the route spec could not load.

The slice 1 spec, moved onto the shared `test/helpers/queued-evaluation.ts`, kept passing (16 tests). That was the control for the move.

The first full PostgreSQL run then failed catalogs that had to learn the new objects:

- **The 0031 revert pattern:** the nonce table and function.
- **The reviewed schema inventory:** the primary key, the checks and the index of `issuer_request_nonces`.
- **`provision-logins.ts`:** it checked every capability table on a database that predates 0057. The nonce table is now checked only once 0057 exists, as the explanation receipts are.

The same file had never checked slice 1's `tenant_capability_issue_for_job`. Both functions are now checked, each once its migration exists: only the issuer may call them.

## The cross-task replay

Two issuer processes share one database here, as two tasks do behind the load balancer. A signed request accepted by the first is refused as `replayed` by the first and by the second, and only one capability exists. A fresh request to the second then succeeds.

## Mutations

Each was applied alone, run against the spec it targets, and restored byte for byte. All nine were caught.

| Mutation                                    | Caught by                                                  |
| ------------------------------------------- | ---------------------------------------------------------- |
| S1: the signature is not compared           | the route spec                                             |
| S2: the timestamp is not checked            | the route spec                                             |
| S3: the body is not part of the signature   | "a body changed after signing"                             |
| S4: another caller name is accepted         | the signature spec                                         |
| S5: the nonce is not claimed                | the replay case                                            |
| S6: the database accepts every nonce        | the replay case, and "once per caller"                     |
| S7: old nonces are never forgotten          | "forgets a nonce once it is older"                         |
| S8: the application login may claim a nonce | the login case                                             |
| S9: the route exists without a worker key   | "does not exist on an issuer started without a worker key" |

S3, S6 and S9 were read by hand: each failed only the test named.

## Meaningful findings and repairs

- **The issuer guard went silent on two of its controls.** The first full loop failed `test:infra` in `issuer.guard.test.mjs`. That guard proves itself by deleting the database refusal code from `IssuerCore`'s `this.refuse('refused', request, outcome.refusal)`. `JobIssuerCore` had an identical line, so the weakened file still matched and nothing was reported. Its `this.refuse('unavailable', request)` also copied a guarded line. The job core now names its parameter `job`, so only the request core satisfies the guard, as intended. The guard itself was not changed.
- **A strict typecheck refused one test's header lookup.** It is typed now.
- **The first full PostgreSQL run had 110 failures, mostly mine.** Moto had not been started, so every S3 test failed at bucket creation. The rerun had it.

## Results

| Run                                                                                                                                      | Commit    | Result                   |
| ---------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------ |
| install, lint, `pnpm test`, build, demo seed, `knowledge:verify --production`, `test:ci-config`, `check:workflows`, `test:launcher-cors` | `85d99c5` | exit 0                   |
| backend, in memory, with services                                                                                                        | `85d99c5` | 3120 passed, 358 skipped |
| backend, PostgreSQL                                                                                                                      | `85d99c5` | 3457 passed, 21 skipped  |
| backend, PostgreSQL and S3                                                                                                               | `85d99c5` | 3477 passed, 1 skipped   |
| worker, with services; F2 and F3 recovery validators                                                                                     | `85d99c5` | exit 0                   |
| browser, all three configurations                                                                                                        | `85d99c5` | 138, 30 and 2 passed     |
| typecheck, `test:infra`                                                                                                                  | `85d99c5` | failed; repaired above   |
| typecheck, lint, `test:infra` (150 passed), `pnpm test`, the issuer suites (277 passed), mutations S1 and S5 again, gitleaks             | `0e55eb0` | exit 0                   |

`0e55eb0` changes only the job core's parameter name and one test's typing after `85d99c5`.

Before the push, the branch was rebased onto `main` `15f0275`: offsite backups' KMS key, the audit bucket's write deny, and spec 012's tasks. No file is in common, the lockfile is unchanged, and the newest migration on `main` is still 0056. On the rebased code the following all exit 0:

- install, typecheck, lint, `pnpm test`, build;
- `test:infra` (150 passed);
- 576 tests on PostgreSQL and S3: the route, slice 1's spec, the 0031 revert, the schema inventory, provisioning, report registration, the recovery CLI, migrations, the issuer server, and every `src/issuer` and `src/db` spec;
- gitleaks.

`85d99c5` and `0e55eb0` are pre-rebase commits, kept under `refs/archive/` in a local checkout.

## Not verified

- **Nothing calls the route yet.** The worker signs and calls it in slice 3.
- **Deployment:** no Terraform passes `ISSUER_WORKER_KEY` to the issuer or the worker.
- **Alarms:** the job core's refusal lines also start with `Capability not issued:`, so `issuer.tf`'s metric filters will count them. Whether `job-not-held` should feed the same alarm is left for slice 3 or the Terraform change.
