# A stopped, failing or overwhelmed capability sweep raises an alarm

Date: 2026-10-31

**Implemented (spec 026, PR B).** `infrastructure/terraform/worker.tf` gains three metric filters on the worker's log group and three alarms into the audit
topic, read from the lines the `capability-sweep` timer writes (PR A, #214):

| Alarm | Fires when |
| --- | --- |
| `worker-capability-sweep-failing` | `capability-sweep-failed` in each of three consecutive minutes (as `worker-schedule-failing`) |
| `worker-capability-sweep-stale` | no `capability-sweep-ran` line for 15 minutes; missing data counts as a breach, so a worker that writes nothing alarms too |
| `worker-capability-sweep-behind` | a run that removed a full batch in every five-minute period for 30 minutes |

`worker.guard.test.mjs` pins each filter and alarm with a weakened-text control for each, and `deploy-contract.test.ts` feeds the filters lines written by the
worker's own `Ticker`. Spec 026's D4 said the failing alarm would count "2 of 2 five-minute periods, like `worker-schedule-failing`"; that alarm actually
needs a failure in each of three consecutive minutes, and this one follows it.

**Not established.**
- Nothing is applied. Apply after PR A's image and migration 0065 are released in an environment, never before (the stale alarm would fire at once).
- No alarm has fired on purpose yet (SC-002 is the founder's step after the apply).
