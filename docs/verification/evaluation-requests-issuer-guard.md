# Verification: queued evaluation and the evaluation worker refuse to start beside the session issuer

Date: 2026-10-28

Scope: `EVALUATION_REQUESTS=enabled` and the evaluation worker are refused while `ISSUER_URL` is set. Configuration only; no migration, no route, no deployment. Synthetic fixtures only. Node 22.22.0 and pnpm 10.28.0 from a frozen offline install; owned PostgreSQL 16 (SCRAM) and Moto. Every run below is on a committed candidate with a clean tree.

## Seen failing first

Before the change, the two new tests failed and their controls passed:

- `env.spec.ts`: "is refused while the session issuer is in use, and never echoes its address".
- `evaluation-worker-config.spec.ts`: "refuses to start while the session issuer is in use, naming the setting and not its address".
- Controls: queued evaluation enabled without the issuer, and the issuer set with queued evaluation off, both load.

## Mutations

Each was applied alone, run against the two spec files, and restored byte for byte. Each failed the test meant for it, and only that test (93 of 94 passed each time).

| Mutation                                 | Caught by                                    |
| ---------------------------------------- | -------------------------------------------- |
| G1: the API refusal removed              | the `env.spec.ts` refusal test               |
| G2: the worker refusal removed           | the worker settings refusal test             |
| G3: the API refusal names the address    | the `env.spec.ts` "never echoes" assertion   |
| G4: the worker refusal names the address | the worker settings "never echoes" assertion |

## Meaningful findings and repairs

- The plan first proposed replacing the worker's hard-coded `roles: ['clinician']`. Tracing showed nothing on that path reads `roles` (`EvaluationsService.create` uses only the organization and the person), so the literal stays, with a comment.
- A first draft of that comment said nothing re-checks the requester at run time. That was wrong: `evaluation_completion_check` (migration 0051) requires the person acting to be the requester and still an active clinician or reviewer. The comment and docs were corrected in `d3453d4`. The guard addresses who proves that person's identity, not a missing check.
- The first local browser run failed to start its S3 fixture because the command left `moto_server` off `PATH`. With the same pinned Moto on `PATH`, all three browser configurations passed.

## Results

| Run                                                                                                                                                               | Commit    | Result                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------ |
| install, typecheck, lint, `pnpm test`, build, demo seed, `knowledge:verify --production`, `test:infra`, `test:ci-config`, `check:workflows`, `test:launcher-cors` | `c1f49a1` | exit 0                   |
| backend, in memory, with services                                                                                                                                 | `c1f49a1` | 3049 passed, 310 skipped |
| backend, PostgreSQL                                                                                                                                               | `c1f49a1` | 3338 passed, 21 skipped  |
| backend, PostgreSQL and S3                                                                                                                                        | `c1f49a1` | 3358 passed, 1 skipped   |
| worker, with services; F2 and F3 recovery validators                                                                                                              | `c1f49a1` | exit 0                   |
| typecheck, lint, the two guard specs (94 passed), the H4 specs on PostgreSQL (48 passed)                                                                          | `d3453d4` | exit 0                   |
| browser, all three configurations                                                                                                                                 | `d3453d4` | 130, 30 and 2 passed     |
| Gitleaks on the branch                                                                                                                                            | `d3453d4` | no leaks                 |

`d3453d4` changes only a comment and two documents after `c1f49a1`.

Before the push, the branch was rebased onto `main` `c0de882` (the usage page and a recovery object-storage fix; no file in common). On the rebased code: install, typecheck, lint, `pnpm test`, build, the two guard specs and `test:ci-config` exit 0, and gitleaks finds no leaks. The SHAs above are the pre-rebase commits, kept under `refs/archive/` in a local checkout.

## Not verified

- The opt-in real-issuer test run (`TEST_REAL_ISSUER=1`) was not run. It sets `ISSUER_URL` for the test app, so the H4 specs that turn queued evaluation on would now refuse to start under it, by design. No CI job sets it.
- No deployment sets `EVALUATION_REQUESTS` or the evaluation worker, so nothing deployed changes.
