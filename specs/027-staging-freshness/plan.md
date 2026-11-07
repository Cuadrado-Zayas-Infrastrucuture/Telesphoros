# Implementation Plan: synthetic staging, and every record about it, stays current, and a person hears when it does not

**Spec**: [spec.md](spec.md)

**Status**: Approved by the founder on 2026-10-31: a Lambda in staging, and D1 to D6 as recommended. Findings are listed in the
email; the check runs daily at 12:00 UTC; GitHub is read without a token, and a refusal makes the run incomplete; an image behind
`main` is a finding after 7 days; the release check is its own file; the Lambda is applied last.

## Summary

There are four PRs, each off `main`, merged in order:

1. **Facts.** `docs/ops/staging-expected.json`, plus a guard that keeps `environments.md` equal to it.
2. **Status.** A read-only `staging-status.sh` that compares live staging with the facts file and runs `plan -detailed-exitcode`. It
   also lists unapplied Terraform PRs and stale saved plans, and shows the stack claim.
3. **Release recipe.** One release recipe in the repo, reading one canonical var file under a claim. It replaces the per-release
   copies.
4. **Daily check.** A daily Lambda in staging that emails findings through the audit topic, plus two alarms for a run that errors or
   does not happen.

Nothing in the recipe applies on a schedule. The founder still runs every apply.

## Technical Context

- **Stack.** Terraform 1.16.5 pinned at `~/telesphoros-private/tools/terraform`, `TF_DATA_DIR=~/telesphoros-private/maindata`, profile
  `telesphoros`, `us-east-2`, applied from the main clone at `…/che/work/telesphoros`, which must be on `main` with no tracked changes.
  Today that clone is at `1bfbdab4`, 7 commits behind `origin/main` `c144dc1d` (#213, #214, #215). #214's migration 0065 and worker
  timer are merged and not released.
- **Recipes today.** `release-6c4714de/release-{image,plan,apply,migrate,verify}.sh` and `release-check.mjs` were copied from
  `release-f03b56e2/` and edited. Their gates are the base var file holding OLD exactly twice, the account and role, no running
  terraform, the clone on `main` and clean, the plan sha256 pinned in the apply script, and `plan-head.txt`. These gates move into
  the repo versions unchanged in strength.
- **Existing Lambda pattern.** `infrastructure/terraform/lambda.tf` packages `infrastructure/lambda/password-change-notifier/dist` with
  `archive_file`, uses a KMS-encrypted log group on `aws_kms_key.service_logs`, and turns log lines into alarms with term-match metric
  filters (the handler's lines are not JSON to CloudWatch).
- **Existing heartbeat pattern.** `api_ledger_check_stale` (`api-compute.tf:902-917`) uses 30 periods of 3600 s, `LessThanThreshold 1`,
  `treat_missing_data = "breaching"` and the audit topic. The run-missed alarm copies it, with 26 periods.
- **Topic.** `aws_sns_topic.audit_alarms` (`audit.tf:452`), encrypted with `aws_kms_key.audit`, with one email subscription
  (`var.alarm_email`).
- **The applied-status guard** (`.github/ci/guard.test.mjs:369-404`) already keeps applied status out of undated files. The new
  facts guard sits beside it, in the same file.

## Constitution Check

- Synthetic data only. No check reads table contents, report contents or log text other than the check's own lines.
- No CI cloud credentials. The Lambda runs in the account, under its own role. CI only runs the unit tests and the guards.
- Founder-run applies, each after reading the plan. PRs stay local until the founder says push.
- No secrets, account id or live values in the repository. The release scripts read them from a private
  `~/telesphoros-private/staging/stack.env`, checked by presence and length only.

## Design

### Facts file (PR 1)

```json
{
  "checked": "2026-10-31",
  "appliedCommit": "<40 hex>",
  "image": { "digest": "sha256:<64 hex>", "commit": "<40 hex>" },
  "taskDefinitions": { "api": 4, "worker": 3 },
  "alarms": 31,
  "newestMigration": "0064",
  "cloudfrontCachePaths": ["/assets/*"],
  "acceptedExceptions": [{ "id": "break-glass-<digest prefix>", "reason": "…", "reviewBy": "YYYY-MM-DD" }]
}
```

The first values are taken from `environments.md` as of `c144dc1d`. They are not trusted until `staging-status` has read them live once
(T009). Before writing the file, the value for `appliedCommit` gets checked: it has to be the clone HEAD the last apply read, which is
`plan-head.txt` in `release-6c4714de/`.

### `staging-status.sh` (PR 2)

It is founder-run, and it reads AWS with the same identity checks as the recipes. It never prints state, plan JSON or var-file
contents:
- `state pull` is piped straight into a node projection that keeps only `serial` and `lineage`.
- Plan output is reduced to resource addresses and actions.

Its exit code is the gate the recipe uses (spec US2.5).

### Release recipe (PR 3)

`scripts/staging/release/{image,plan,apply,migrate,verify}.sh` and `release-check.mjs`. Every run writes to
`~/telesphoros-private/releases/<commit>/`, and that folder holds outputs only, never copies of the scripts. The canonical var file is
`~/telesphoros-private/staging/current.tfvars`. After the IMAGE apply exits 0, `apply.sh` promotes the release's file to it. It then
prints the facts-file diff for the docs PR (the person opens that PR; nothing is pushed by the script).

### Daily check (PR 4)

`infrastructure/lambda/staging-freshness/` (TypeScript, tsup, the notifier's layout) and `infrastructure/terraform/freshness.tf`:
- **Role, read-only.** `ecs:DescribeServices`, `ecs:DescribeTaskDefinition`, `cloudwatch:DescribeAlarms`, `cloudfront:GetDistribution`
  (on this distribution), its own log writes, and `sns:Publish` on the audit topic, plus the KMS actions the topic needs.
- **Schedule.** An EventBridge Scheduler schedule (D2).
- **Two alarms.** `freshness-check-missed`, with the heartbeat shape above, and `freshness-check-failing`, on the Lambda's `Errors` metric.
  Both go to the audit topic. The facts file's alarm count rises by 2 in the PR that applies them.
- **Created only in the synthetic profile.** A production design is out of scope.

## Decisions (approved as recommended, 2026-10-31)

| | Decision | Recommended | Alternative |
| --- | --- | --- | --- |
| D1 | How findings reach you | The Lambda publishes one message listing each finding to the audit topic | A metric and an alarm only: the email says "drift" and you run `staging-status` to learn what |
| D2 | When it runs | Daily at 12:00 UTC (08:00 in San Juan) | Twice daily |
| D3 | GitHub access | Unauthenticated; a refused request makes the run incomplete and emails you | A read-only token in Secrets Manager: no rate limit, one more secret to rotate |
| D4 | When an image behind `main` counts as a finding | 7 days after the first merged application change it does not contain | 3 or 14 days |
| D5 | Where the release plan check lives | Its own file, `scripts/staging/release/release-check.mjs`, tested in CI; `check-plan.mjs` unchanged | New stages in `check-plan.mjs` |
| D6 | Order | PR 1, 2, 3, then 4 applied last, in its own reviewed plan | PR 4 first |

## Risks

- **R1.** The audit key's policy may not let a Lambda role use it for SNS. It is read at build time; if it does not, PR 4 adds one
  statement, reviewed line by line.
- **R2.** Applying PR 4 also applies anything else merged and unapplied (stale state 1). `staging-status` must show exit 0 with PR 4
  excluded, or the founder chooses what to fold in, as with #210.
- **R3.** The first run will report the #214 release gap and the break-glass images. That is correct, and SC-001 counts it.
- **R4.** A docs PR after every apply is a new duty. Until it merges, the Lambda reports the gap daily, by design.

## Verification

- Unit tests with fixtures for each check, with a positive control (all equal, no finding) and one break-it control per field.
- A guard break-it control for each facts field.
- The Terraform guard tests and `terraform test` for `freshness.tf`.
- The full local loop before each PR.
- A rehearsal of `apply.sh` against a transition with a local backend: a real plan, an apply, the var file promoted, and a second saved
  plan refused as stale.
- SC-002 and SC-004 in staging after the founder applies PR 4.
