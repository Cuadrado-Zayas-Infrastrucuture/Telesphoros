# The daily staging freshness check

Spec 027, PR 4. Whether it is applied is in [environments.md](environments.md), the one page that says what exists in AWS. Synthetic staging only. Spec: [specs/027-staging-freshness](../../specs/027-staging-freshness/).

A Lambda in the staging account runs once a day at 12:00 UTC (08:00 in San Juan). It reads
[staging-expected.json](staging-expected.json) from `main` in the public repository and compares it with the account, then emails the
`telesphoros-staging-audit-alarms` topic (the same confirmed address as every alarm) when anything is stale. It reads and publishes one
message; its role can change nothing. Counts, revisions, digests, file names and dates only: no state, plan, log text or variable value.

## What it checks, and what an email field means

| Field in the email | Meaning | What to do |
| --- | --- | --- |
| `api.revision`, `worker.revision`, `api.digest`, `worker.digest` | ECS runs another task definition or image than the facts file says | Someone released or rolled back. Run `scripts/staging/staging-status.sh`, then update the facts file and [environments.md](environments.md) in one pull request |
| `alarms` | The number of CloudWatch alarms with the stack's prefix changed | An apply added or removed alarms. Update the facts file and the page |
| `cloudfrontCachePaths` | The distribution's cache behaviours changed | Same |
| `ready` | The API's `/api/v1/ready` did not answer 200 | The API is down or its migrations are behind its image: look at the service first |
| `terraform-unapplied` | Files under `infrastructure/terraform/` changed on `main` after the applied commit | Merged and not applied. Plan it as its own INFRA plan ([staging-release.md](staging-release.md)) before the next release |
| `image-behind-main` | An application change merged 7 or more days ago is not in the running image | Release it, or record why not |
| `exception:<id>` | An accepted exception passed its review date | Review it: fix it, or extend the date in the facts file with a reason |
| `could not read <thing> (<error class>)` | A read failed (AWS, GitHub or the facts file). The run is **incomplete**, never clean | Usually GitHub's unauthenticated rate limit or a permission change; open the log group |

The newest migration is not read directly. `/api/v1/ready` answers 200 only when the running image's migrations are applied; whether
`main` has a newer migration than the image is what `image-behind-main` and `terraform-unapplied` surface, and `staging-status.sh` compares it
in git.

## When it cannot tell you

| Failure | What reaches you |
| --- | --- |
| A read fails | An email saying the check is incomplete, with the findings it did get |
| The email cannot be sent | The invocation fails: the `freshness-check-failing` alarm (any Lambda error) |
| No complete run for 26 hours, including a function that never runs | The `freshness-check-missed` alarm (a missing data point counts as a breach) |
| The alarm topic itself is broken | Nothing, as for the other alarms. The topic has one confirmed subscription; check it when you check the alarms |

## Applying it (founder-run, after reading the plan)

1. Not by hand: `plan.sh` builds every Lambda in the backend clone before it plans (spec 027 T022), so the zip is this commit's code.
2. `plan.sh INFRA COMMIT` ([staging-release.md](staging-release.md), step 3). Expect, beyond the Lambda: one in-place update of the service-logs
   key policy (it names the new log group), and nothing else. Read the plan line by line: 10 creates (log group, role, role policy,
   function, schedule rule, target, invoke permission, metric filter, two alarms) and that one update. Then `apply.sh INFRA COMMIT SHA256`.
3. After the apply, the facts file's `alarms` goes up by 2 and [environments.md](environments.md) is updated in the same pull request.
4. Invoke it once by hand and read the email. The first email is expected to list whatever is merged and unapplied at that moment.
5. Cause each condition once on purpose (spec 027 T017) and see each email arrive; put it back each time.
