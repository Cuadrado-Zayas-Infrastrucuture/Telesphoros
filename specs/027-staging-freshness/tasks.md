# Tasks: synthetic staging, and every record about it, stays current, and a person hears when it does not

**Spec**: [spec.md](spec.md) · **Plan**: [plan.md](plan.md) · Lambda chosen (founder, 2026-10-31); D1 to D6 open.

## PR 1: the facts file

- [ ] T001 Test first: the facts guard in `.github/ci/guard.test.mjs`, one break-it control per field, a positive control, and a
  no-account-id/ARN check; red before the file exists.
- [ ] T002 `docs/ops/staging-expected.json` with the values from `environments.md` at `c144dc1d`; `appliedCommit` from `plan-head.txt`.
- [ ] T003 `environments.md`: say the JSON is the source and the table restates it. Full local loop. A PR when the founder says push.

## PR 2: `staging-status`

- [ ] T004 Test first: the projections (state to serial and lineage only, plan to addresses and actions only), with a test that a
  value never reaches the output.
- [ ] T005 `scripts/staging/staging-status.sh` and its node helper: the facts comparison, `plan -detailed-exitcode -lock=false`, the
  merged-Terraform PR list, the saved-plan scan, the claim, and the exit code.
- [ ] T006 `CLAUDE.md` and `docs/ops/environments.md`: any session that plans against staging runs `staging-status` first and quotes its
  table. Full local loop; a PR when the founder says push.

## PR 3: one release recipe

- [ ] T007 Test first: `release-check.mjs` moved from `release-6c4714de/` with its tests (`release-f03b56e2/release-check.test.mjs`),
  the claim, and the promotion of the var file.
- [ ] T008 `scripts/staging/release/*.sh`: the gates moved unchanged in strength, live values from `stack.env`, outputs in
  `releases/<commit>/`, `current.tfvars` the only var file accepted.
- [ ] T009 Rehearse with a local backend: a real transition, the promotion, a second saved plan refused (by the recipe and by
  Terraform). shellcheck, re-run after every suppression. Full local loop; a PR when the founder says push.
- [ ] T010 Founder: create `~/telesphoros-private/staging/current.tfvars` from `release-6c4714de/release.tfvars`, then run
  `staging-status` once. Its table is the first live read of the facts file.

## PR 4: the daily check

- [ ] T011 Read the audit key policy (R1), read-only.
- [ ] T012 Test first: the handler with fixtures, one break-it per check, an incomplete run on a refused read and on a GitHub refusal,
  and the message holding counts and digests only.
- [ ] T013 `infrastructure/lambda/staging-freshness/` and `infrastructure/terraform/freshness.tf`, with their guard tests and
  `terraform test`. Add any new conditional CI step to `HEAVY_STEPS`.
- [ ] T014 Full local loop; a PR when the founder says push.

## Release (founder)

- [ ] T015 `staging-status` exit 0 (or the founder's choice of what to fold in, R2); plan PR 4; read it line by line; apply.
- [ ] T016 Invoke the Lambda once by hand; see an email with today's findings (expect #214 and the break-glass images, R3).
- [ ] T017 SC-002 and SC-004: break each check once on purpose, and deny one read, and see each email; return each to OK.
- [ ] T018 Facts file and `environments.md` updated in a docs PR (alarm count plus 2). SC-001 runs for 14 days.
