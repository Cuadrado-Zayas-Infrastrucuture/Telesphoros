# Verification: the evaluation worker runs under issuer capabilities (spec 012 slice 3)

Date: 2026-10-29

Scope:

- `runWithCapability` and the capability source in `Database.withTenant`, `HttpJobCapabilityClient`, the consumer, and the settings `EVALUATION_WORKER_ISSUER_URL`, `EVALUATION_WORKER_ISSUER_KEY` and `EVALUATION_REQUESTS_WORKER_BINDING`.
- Synthetic data only: the public fixture D01.
- A real issuer process (`startIssuer`, its own core, store and database login, slice 2's job route) on owned PostgreSQL 16 (SCRAM), with Moto for the storage tier.
- Node 22.22.0 and pnpm 10.28.0 from a frozen offline install.
- Every result below is from the committed candidate with a clean tree, unless marked as a development run.
- Test keys are generated per run and never written down.

## The end-to-end spec

`apps/backend/test/evaluation-request-worker-capability.e2e-spec.ts` runs on the PostgreSQL tier, so CI runs it. It does not wait for `TEST_REAL_ISSUER`, which only points the API's guard at an issuer and is set by no workflow. Each case uses its own organization.

| Case                                                             | What is asserted                                                                                                                                                                                        |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SC-001 (control)                                                 | D01 is stored with its completion. At least two capabilities were asked for, the issuer logged each one as issued for the requester, and as many capabilities exist as were asked for: none was reused. |
| US2.1, a requester removed after queuing                         | The issuer refuses `membership-not-current` and logs it; the job ends `requester-not-authorized`; nothing is read or stored.                                                                            |
| US2.2, a requester who is now only a reader                      | `role-not-allowed`; `requester-not-authorized`; nothing read or stored.                                                                                                                                 |
| US2.3, a suspended organization                                  | `tenant-inactive`; `tenant-inactive`; nothing read or stored.                                                                                                                                           |
| US2.4, removed while the read runs                               | The storing transaction is refused its capability (`membership-not-current`, the last log row); nothing is stored.                                                                                      |
| A worker whose lease was lost                                    | `job-not-held` before reading; the new holder completes.                                                                                                                                                |
| A capability naming another person, or another organization      | `requester-not-authorized`; nothing stored.                                                                                                                                                             |
| An issuer that cannot be reached; a key the issuer does not hold | Retried (`issuer-unavailable`, `issuer-unauthenticated`); nothing read or stored; the issuer logged no answer.                                                                                          |
| The guard (FR-006)                                               | A worker without the issuer settings still refuses to start beside `ISSUER_URL`; with both it starts.                                                                                                   |

All 11 passed on their first run, so they were not counted until the mutations below had shown that they fail.

## Mutations

Each was applied alone, run against the spec it targets, and restored byte for byte. All nine were caught on the working tree and again on `3488957`.

| Mutation                                                          | Caught by                                 |
| ----------------------------------------------------------------- | ----------------------------------------- |
| W1: the database ignores the capability source                    | the end-to-end spec                       |
| W2: one capability is reused across a job's transactions          | SC-001 and US2.4                          |
| W3: the person is taken from the request, not the issuer          | "a capability names another person"       |
| W4: the organization is not compared                              | "a capability names another organization" |
| W5: an unreachable issuer ends the job                            | the retry cases                           |
| W6: `job-not-held` is reported as the person's refusal            | the lost-lease case                       |
| W7: the worker accepts the address without the key                | the worker settings spec                  |
| W8: the worker starts beside `ISSUER_URL` without issuer settings | the worker settings spec                  |
| W9: the API ignores `EVALUATION_REQUESTS_WORKER_BINDING`          | the API settings spec                     |

W2, W3 and W6 were read by hand: each failed only the tests named.

## Meaningful findings and repairs

- **A tenant id is not a UUID.** The client first read `tenantId` as a UUID; test organizations are `tenant-…` text, as `tenants.id` allows. It reads text now and compares it with the job's own. Found before any run, while reading `LabPipeline`.
- **The boundary test caught a comment.** Its first version counted a mention of `runWithCapability` in a `database.ts` comment as a use. It now matches calls and the definition.

## Results

| Run                                                                                                                                                 | Commit    | Result                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | --------------------------- |
| install, typecheck, lint, `pnpm test`, build, demo seed, `knowledge:verify --production`, `test:ci-config`, `check:workflows`, `test:launcher-cors` | `3488957` | exit 0                      |
| `test:infra`                                                                                                                                        | `3488957` | 150 passed                  |
| backend, in memory, with services                                                                                                                   | `3488957` | 3181 passed, 371 skipped    |
| backend, PostgreSQL                                                                                                                                 | `3488957` | 3531 passed, 21 skipped     |
| backend, PostgreSQL and S3                                                                                                                          | `3488957` | 3551 passed, 1 skipped      |
| worker, with services; F2 and F3 recovery validators                                                                                                | `3488957` | exit 0                      |
| browser, foundation configuration                                                                                                                   | `3488957` | 153 passed, 3 skipped       |
| browser, local configuration                                                                                                                        | `3488957` | 29 passed, 1 failed (below) |
| browser, local configuration: the failed spec alone, three times                                                                                    | `3488957` | 8 passed each time          |
| browser, owned-local configuration (not reached by the chained run)                                                                                 | `3488957` | 2 passed                    |
| the nine mutations, again on the commit                                                                                                             | `3488957` | all caught                  |
| gitleaks over the branch                                                                                                                            | `3488957` | no leaks                    |

The end-to-end spec's 11 cases are part of the two PostgreSQL rows.

**The one browser failure, cause unproven.** In the full run, `local-e2e/interpretation-preview.spec.ts:66` (desktop) took 10.1 minutes and hit its 30 s timeout waiting for the "Explanation conversation" region. This branch changes no file under `apps/frontend` or `packages`. Run alone on the same commit, the spec passed three times out of three in about 54 s. Because the chained `e2e` script stops at the first failure, the owned-local configuration was run on its own afterwards.

Before the push, the branch was rebased onto `main` `a6fea4c`. The commits between are documentation only: specs 019 and 020, and the S3 default-key check. No file is in common, the lockfile is unchanged, and a range-diff shows both commits unchanged. On the rebased code, install, typecheck, lint, `pnpm test`, build, `test:infra` and the backend on PostgreSQL and S3 (the end-to-end spec included) were run again, and so was gitleaks. `3488957` and `d05d967` are the pre-rebase commits, kept under `refs/archive/` in a local checkout.

## Not verified

- **Deployment.** No Terraform passes `ISSUER_WORKER_KEY` to the issuer, or the worker settings to a worker, and no worker is deployed.
- **The `capability` binding mode.** `tenant_binding_mode` stays `dual`.
- **Alarms.** The job route's refusals are also counted by issuer.tf's "Capability not issued" filters. Whether they should be is still open.
- **A capability that expires inside one transaction.** Each transaction asks for its own, and `withTenant` refuses one already expired. A single transaction longer than 60 s is not exercised.
