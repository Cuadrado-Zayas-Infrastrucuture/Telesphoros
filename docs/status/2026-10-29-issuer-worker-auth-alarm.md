# Feature: an alarm for failed worker signatures at the session issuer (spec 012 follow-up, local)

Date: 2026-10-29

Spec 012 lets the evaluation worker sign job-capability requests to the issuer. When a signature fails (none, an unknown caller, a malformed or wrong one, a stale clock), the issuer answers 401 and logs `Issuer request rejected: unauthenticated (<reason>)`. The worker retries such jobs (#162), and no metric filter read that line. A key that no longer matches after a rotation, or a worker clock that drifts, would therefore keep jobs retrying with nobody alerted.

## What changed

- `infrastructure/terraform/issuer.tf`:
  - A metric filter on that phrase, `IssuerWorkerUnauthenticated`.
  - An alarm into the audit topic at five in five minutes, like the issuer-unavailable alarm. Silence is normal for it.
  - The threshold is provisional, like the others, until the staging measurement (decision D4).
- `issuer.guard.test.mjs`:
  - It checks the filter's phrase, the alarm's metric, threshold, period, topic and missing-data rule, and that the issuer server still writes the phrase.
  - It has controls for a missed phrase, a raised threshold, an alarm that tells nobody, silence treated as a breach, and a server that stops writing the line.

## What the existing alarms already cover

- The job route's `Capability not issued: unavailable` lines count toward `IssuerUnavailable`, as the request route's do. A database that does not answer is the same fault for both.
- Job refusals such as `job-not-held` match no filter, and should not: a lost lease is normal.

## How it was verified

See the [verification record](../verification/issuer-worker-auth-alarm.md).

## Not changed

- Nothing is applied. The filter and alarm exist only where the issuer does (`local.api_count`), and no deployment passes the worker key yet.
- Cost when applied: one more CloudWatch alarm, about USD 0.10 a month. Metric filters themselves cost nothing.

Local only until the founder says push.
