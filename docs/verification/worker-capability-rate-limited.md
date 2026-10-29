# Verification: a rate-limited job capability is retried, not fatal

Date: 2026-10-29

Scope:

- `capabilityError` in `apps/backend/src/lab-reports/evaluation-request-consumer.ts`.
- One new case in `test/evaluation-request-worker-capability.e2e-spec.ts`, on owned PostgreSQL 16 with a real issuer process.
- Synthetic data only.

## The case

The case switches enforcement on for `evaluation-job` with a burst of 1, in the test database only. The job's first transaction is issued and its second is refused `rate-limited`. Then:

- the job is retried as `issuer-rate-limited`;
- nothing is stored;
- the issuer's log shows the issued row and the refusal.

The setting is restored to the value read before the change. The same worker, still holding the job, then completes it.

## Seen failing

With the new line removed, the case fails: the job ends as `requester-not-authorized`, not retryable. The other 11 cases pass. That is the bug this fixes.

## Results

| Run                                                                                                                                    | Commit       | Result                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the capability end-to-end spec (development run)                                                                                       | working tree | 12 passed                                                                                                                                                  |
| install, typecheck, lint, build, demo seed, `knowledge:verify --production`, `test:ci-config`, `check:workflows`, `test:launcher-cors` | `b5b34af`    | exit 0                                                                                                                                                     |
| `test:infra`                                                                                                                           | `b5b34af`    | 150 passed                                                                                                                                                 |
| backend: memory / PostgreSQL / PostgreSQL and S3                                                                                       | `b5b34af`    | 3181 / 3532 / 3552 passed                                                                                                                                  |
| worker with services; F2 and F3 recovery validators                                                                                    | `b5b34af`    | exit 0                                                                                                                                                     |
| browser: foundation / local / owned-local                                                                                              | `b5b34af`    | 153 / 30 / 2 passed                                                                                                                                        |
| `pnpm test`                                                                                                                            | `b5b34af`    | failed once on `apps/worker` `health.test.ts` (503 for 200), a known flaky test this change does not touch (fixed separately in #164); passed on the rerun |
| gitleaks                                                                                                                               | this head    | no leaks                                                                                                                                                   |

## Not verified

- **Real limits.** Enforcement stays off (`enforce_limits` is false), and the limits are provisional.
- **How many retries a job gets.** A long burst could use them up: the job runner's own attempt limit applies, as for any retried code.
