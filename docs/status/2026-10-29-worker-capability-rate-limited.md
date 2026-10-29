# Fix: a rate-limited job capability is retried, not fatal (spec 012 follow-up, local)

Date: 2026-10-29

Spec 012 slice 3 (#162) ended a job as `requester-not-authorized` for every issuer refusal it did not name, `rate-limited` included. Limits are only counted today (migration 0028, `enforce_limits` is false), so this could not happen yet. Once they are enforced, a requester with many queued requests would lose them for good, although the refusal says only that the person was issued many capabilities lately, not that they may not have this one.

## What changed

- `evaluation-request-consumer.ts` maps `refused (rate-limited)` to a retried `issuer-rate-limited`.
- `docs/lab-report-reader.md` lists it with the other retried causes.

## How it was verified

See the [verification record](../verification/worker-capability-rate-limited.md):

- A new end-to-end case switches enforcement on with a burst of 1. The job is retried, nothing is stored, and the same worker completes once the limit allows.
- With the fix removed, the case fails with `requester-not-authorized`.
- The full local loop.

## Not changed

- The limits and their enforcement.
- The database functions and Terraform.

Local only until the founder says push.
