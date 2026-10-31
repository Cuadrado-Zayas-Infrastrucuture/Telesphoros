# Feature Specification: synthetic staging, and every record about it, stays current, and a person hears when it does not

**Feature Branch**: `docs/spec-027-staging-freshness` (spec only; each implementation PR gets its own branch off `main`)

**Created**: 2026-10-31

**Status**: Approved by the founder on 2026-10-31, including where the daily check runs: a Lambda in synthetic staging, not launchd on
the founder's Mac. D1 to D6 in [plan.md](plan.md) approved as recommended (2026-10-31).

**Input**: the 6c4714de release of spec 025 PD-a to synthetic staging (2026-10-30 and 2026-10-31). Line numbers cite `main` `c144dc1d`.

## The problem

Five kinds of staleness showed up in one release. Each one cost a session time, and two of them reached a saved plan.

| # | Stale state | What happened |
| --- | --- | --- |
| 1 | Terraform merged but not applied | #195, #198, #202 and #210 each sat on `main` unapplied. A plan made later from `main` carried other people's changes. #210's six deletes surprised three sessions and were folded into the PD-a MIGRATE apply by the founder's choice. #214 (migration 0065, worker timer) is merged and not released today |
| 2 | `docs/ops/environments.md` drifted from AWS | It still said image `888979b` and 33 alarms after the `f03b56e2` release, until #215 |
| 3 | Stale inputs in the recipe | `stageC/stage-c.tfvars` still named the first image. The current var file was the previous release's `release.tfvars`, found by reading the folders |
| 4 | Saved plans going stale | Every apply makes other saved plans stale, and several sessions plan against one stack |
| 5 | Sessions working from stale knowledge | A peer session believed a plan had been pinned before #210 when it had not |
| 6 | The running image is behind `main`, and break-glass images are never re-released | Three images pushed by hand ([ci-cd.md](../../docs/ops/ci-cd.md) "Break-glass"), none released through CI. That cannot change while the organization's SCP denies GitHub OIDC |

These are all one bug class: a record that is true when it is written and that nothing re-checks.

## What this does not change

- **No CI job gets cloud credentials.** The organization SCP denies GitHub OIDC, and the rule stands on its own regardless.
- **Every staging apply is still run by the founder** after reading the plan. Nothing here applies anything on a schedule.
- **`scripts/staging/check-plan.mjs` stages A, B, C, SES and WEB are unchanged.**
- **Dated records** (`docs/status/`, `docs/verification/`, plans, specs, `CHANGELOG.md`) keep the wording of their date.
- **Synthetic data only.** No check reads a table, a report or a log line with content. Every output is counts, digests, revision
  numbers and PR numbers.

## User scenarios

### US1: the facts about staging live in one checked file (P1)

As the founder, I want what staging should be running written once, in a form a program can compare, so that a page cannot quietly
disagree with AWS.

**Acceptance:**
1. `docs/ops/staging-expected.json` records the commit last applied, the image digest and its commit, the API and worker task-definition
   revisions, the alarm count, the newest migration, the CloudFront cache paths, and each accepted exception with a review-by date.
2. A guard fails CI when `environments.md` states any of those values differently from the file, and passes when they agree. It has a
   positive control and one break-it control per field.
3. The file holds no account id, ARN, hostname that is not already public, or secret. A guard checks this.

### US2: one read-only command says what staging is, before anyone plans (P1)

As a session or the founder about to plan against staging, I want one command that shows live staging against the facts file, so no plan
starts from a belief.

**Acceptance:**
1. `scripts/staging/staging-status.sh` (founder-run, read-only) prints a table: each field of the facts file, its live value, and
   `ok` / `DRIFT` / `unknown`. A refused read is `unknown`, never `ok`.
2. It runs `terraform plan -detailed-exitcode -lock=false` with the canonical var file (US3) and reports exit 0 (nothing to do),
   2 (changes: the resource addresses only, never values) or 1 (failed).
3. It lists the merged PRs that touched `infrastructure/terraform/` between the facts file's applied commit and `main`.
4. It lists every saved plan under `~/telesphoros-private/` that is newer than the last apply, marked `STALE` when the state serial
   it was made from is not the current one. It also shows the stack claim (US4).
5. It exits non-zero on any `DRIFT`, `unknown`, stale plan or unapplied Terraform, so a recipe can use it as a gate.

### US3: a release reads one var file, and cannot read an old one (P1)

As the founder, I want one canonical var file for staging, so no recipe can plan from a file left in an older release folder.

**Acceptance:**
1. `~/telesphoros-private/staging/current.tfvars` is the only var file the release scripts accept, with its sha256 recorded beside it.
2. The plan step refuses to start unless the image lines in that file equal what ECS runs.
3. A successful IMAGE apply writes the new file and its hash. The plan step writes the new values into a separate file, and only
   the apply promotes it to `current.tfvars`.
4. The release scripts live in the repo (`scripts/staging/release/`), tested in CI, with no account id or other live value in them.
   Those values come from a private file outside the repository. The per-release copies in `~/telesphoros-private/release-*/` stop.

### US4: two sessions cannot plan or apply against the stack at once (P2)

**Acceptance:**
1. Plan and apply each take a claim (`mkdir ~/telesphoros-private/staging/claim`, holding owner, reason and start time) and refuse when
   another claim exists.
2. `staging-status` shows the claim and its age. A claim older than 24 hours is reported as abandoned and is never broken automatically.
3. Each saved plan gets a record next to it: the state serial and lineage, the clone HEAD and the var file's sha256. The apply refuses a
   plan whose serial is not the current one, even before Terraform's own stale-plan refusal (verified in a rehearsal, T0xx).

### US5: staging drifting, or the check stopping, reaches the founder by email (P1)

As the founder, I want a daily check in staging itself that emails me when staging or its records are stale, and a separate alarm when
the check does not run.

**Acceptance:**
1. A Lambda in staging runs once a day on an EventBridge schedule. It has a read-only role plus publish rights on the audit alarms topic.
2. It reads `docs/ops/staging-expected.json` and `docs/ops/ci-cd.md` from `main` in the public repository, and compares them with live
   ECS (image digest, task-definition revisions), the CloudWatch alarm count, the CloudFront cache paths and `/api/v1/ready` on the API.
3. It names any Terraform PRs merged after the applied commit, and an image behind `main` by an application change for longer than D4's limit.
4. When a check finds something, it publishes one message to `telesphoros-staging-audit-alarms`. That topic's single subscription is the
   founder's confirmed email. The message lists each finding as field, expected and live, with counts and digests only.
5. Every run writes one counts-only completion line. An alarm fires when no completion line arrives for 26 hours (missing data counts as
   a breach), and another fires on any Lambda error. A run that cannot read GitHub or AWS is incomplete, never clean.
6. Each check is broken on purpose once in staging, and the email is seen to arrive (SC-002).

### US6: what cannot be fixed is reported with a date, not forgotten (P3)

**Acceptance:**
1. The break-glass images are accepted exceptions in the facts file, each with a reason and a review-by date. The daily check reports an
   exception only after its review-by date has passed.
2. Re-releasing through CI stays out of scope while the SCP denies GitHub OIDC. This spec records that, and does not work around it.

## Success criteria

- **SC-001**: For 14 days after release, the daily check's finding count is reported each day. Each finding is either fixed or recorded
  as an accepted exception within 2 working days.
- **SC-002**: Each of the six stale states (table above) is caused once on purpose in staging, or in a staging-shaped rehearsal where
  causing it in staging is unsafe, and an email naming it arrives.
- **SC-003**: The next release after this one runs from `scripts/staging/release/` and `current.tfvars` alone, with no per-release
  copies of scripts or var files.
- **SC-004**: An incomplete run (GitHub unreachable, a refused AWS read) produces an email, proved once by denying one read.

## Assumptions and limits

- **The daily check cannot run `terraform plan`.** It reads observable proxies (image, revisions, alarm count, cache paths, `/api/v1/ready`) and
  the PR list. The authoritative check is `staging-status`, which runs where the founder's credentials are and only when he is present.
- **`/api/v1/ready` includes `migrationsAppliedCheck`** (`apps/backend/src/health/health.module.ts:18`). So 200 means the running image's
  migrations are applied. It does not say a newer migration on `main` is waiting; `staging-status` compares that from git.
- **GitHub's unauthenticated API allows 60 requests an hour per address**, and Lambda's outbound addresses are shared. A refused request
  makes the run incomplete, which emails the founder (D3).
- **Assumed, not verified:** that the audit topic's KMS key policy lets a Lambda role publish. It is read at build time (plan risk R1).
