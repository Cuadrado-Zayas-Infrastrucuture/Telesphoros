# The stored-file check job may carry the id of the request that caused it (2026-10-24)

Date: 2026-10-24

**Implemented, first of two steps (no migration).** From the production-readiness audit (item 50, Medium: "a job cannot be traced to its request"). This step makes the receiving side ready: the `files.verify-stored` payload may carry an optional `requestId`, the worker accepts it, and the `file-verified` log line names it when present. Nothing writes the id yet, so behaviour today is unchanged.

**What changed.** `packages/jobs` `filesVerifyStored` payload: `reportId` as before plus an optional `requestId` that must match the same pattern the database enforces for job payload strings (`^[A-Za-z0-9-]{1,64}$`; an id with a dot or underscore is refused here as the `jobs_payload_shape` constraint would refuse it). The strict object still refuses any other extra key. The worker's `file-verified` line gains `requestId` when the payload has one; the logger already drops any string that is not a short code, so it cannot carry anything else. A job without it logs exactly as before.

**Why two steps.** The second step is a migration: a nullable `request_id` on `outbox_events`, a 3-argument `outbox_append`, and `outbox_relay` copying the id into the job payload; the API passes the id it already holds (`currentRequestId()`). If that migration ran before every worker accepted the new key, an older worker would reject the payload as `invalid-payload` and dead-letter the job (the schema is strict). Shipping the worker side first keeps the migration `expand`. **The second step is not built yet and waits for this one to be merged** (it would otherwise be a stacked branch). It must also pass on only ids of the allowed shape: a caller-supplied `X-Request-Id` may contain dots and underscores, which the jobs table refuses.

**Tests, red first.** `jobs.test.ts` (2 new): the payload with and without `requestId` parses and passes the flat-payload rule; ids with spaces, dots, underscores, empty, too long or not a string are refused, as is any other extra key. `consumers.test.ts` (1 new): the log line names the request when the job carries one and writes no key when it does not. `log.test.ts` (1 new): a short-code `requestId` is written and anything else is dropped. A deliberate breakage (the handler leaves `requestId` out of the line) turns the handler test red.

**Limits.** Nothing is traced end to end until step two lands. Only `files.verify-stored` has an outbox route; the scheduled `files.verify-stale` has no request behind it. Not verified in AWS.
