# Tasks: synthetic staging, and every record about it, stays current, and a person hears when it does not

**Spec**: [spec.md](spec.md) · **Plan**: [plan.md](plan.md) · Lambda chosen; D1 to D6 approved as recommended (founder, 2026-10-31).

## PR 1: the facts file

Done: #223 (merged 2026-10-31).

- [x] T001 Test first: the facts guard in `.github/ci/guard.test.mjs`, one break-it control per field, a positive control, and a
  no-account-id/ARN check; red before the file exists.
- [x] T002 `docs/ops/staging-expected.json` with the values from `environments.md` at `c144dc1d`; `appliedCommit` from `plan-head.txt`.
- [x] T003 `environments.md`: say the JSON is the source and the table restates it. Full local loop. A PR when the founder says push.

## PR 2: `staging-status`

Done: #227 (merged 2026-11-01).

- [x] T004 Test first: the projections (state to serial and lineage only, plan to addresses and actions only), with a test that a
  value never reaches the output.
- [x] T005 `scripts/staging/staging-status.sh` and its node helper: the facts comparison, `plan -detailed-exitcode -lock=false`, the
  merged-Terraform PR list, the saved-plan scan, the claim, and the exit code.
- [x] T006 `CLAUDE.md` and `docs/ops/environments.md`: any session that plans against staging runs `staging-status` first and quotes its
  table. Full local loop; a PR when the founder says push.

## PR 3: one release recipe

Done: #231 (merged 2026-11-01). T010 by the founder: `current.tfvars` and its `.sha256`, which `staging-status` and every
release step check.

- [x] T007 Test first: `release-check.mjs` moved from `release-6c4714de/` with its tests (`release-f03b56e2/release-check.test.mjs`),
  the claim, and the promotion of the var file.
- [x] T008 `scripts/staging/release/*.sh`: the gates moved unchanged in strength, live values from `stack.env`, outputs in
  `releases/<commit>/`, `current.tfvars` the only var file accepted.
- [x] T009 Rehearse with a local backend: a real transition, the promotion, a second saved plan refused (by the recipe and by
  Terraform). shellcheck, re-run after every suppression. Full local loop; a PR when the founder says push.
- [x] T010 Founder: create `~/telesphoros-private/staging/current.tfvars` from `release-6c4714de/release.tfvars`, then run
  `staging-status` once. Its table is the first live read of the facts file.

## PR 3b: the steps around the plans (added 2026-11-06, after the 661512c9 release ran them from re-pinned copies)

Done: T019 and T020 in #300 (merged 2026-11-06), T021 in #301 and T022 in #303 (both merged 2026-11-07).

- [x] T019 Test first: `migration-pending.mjs` (the migrations after `newestMigration` on `origin/main`; exactly those on a first run, a
  tail only after an interrupted `migrate-up`), and `image.sh` and `migrate.sh` against stand-ins, one refusal per gate, each gate broken
  once on purpose and seen red.
- [x] T020 3b-1: `image.sh` and `migrate.sh` with the gates of the 661512c9 copies unchanged in strength, nothing release-specific in them
  (the reason for an unsigned image is a file per release), and the Terraform version read without a pipe in `lib.sh` and
  `staging-status.sh`. shellcheck; full local loop; a PR when the founder says push.
- [x] T021 3b-2: `verify.sh`, `frontend.sh` and `state-backup.sh`, the same way. Expected settings come from `current.tfvars`, the hosts
  from `stack.env` (`API_BASE_URL`, `APP_URL`, which the founder adds before the next release), the backup's serial floor from the IMAGE
  plan's record; the frontend publishes only after a verification newer than the last apply. An open medication fence is refused, not
  verified (the fence checker judges a closed fence only).
- [x] T022 (added 2026-11-07, before PR 4 adds a second Lambda): every plan builds each `infrastructure/lambda/*` in the clone (frozen
  install, emptied `dist`, umask 022, files 644) and records the zips; `apply.sh` refuses a zip changed since the plan. A guard that every
  function is such a bundle with `source_code_hash`; a rehearsal against the real archive provider (mode in the hash, file times not).

## PR 4: the daily check

Done: #304 (merged 2026-11-07). R1 was answered from `kms.tf` (the key policy's account statement lets the role's own IAM
grant suffice) and held live: the log group was created under that key and the function writes to it.

- [x] T011 Read the audit key policy (R1), read-only.
- [x] T012 Test first: the handler with fixtures, one break-it per check, an incomplete run on a refused read and on a GitHub refusal,
  and the message holding counts and digests only.
- [x] T013 `infrastructure/lambda/staging-freshness/` and `infrastructure/terraform/freshness.tf`, with their guard tests and
  `terraform test`. Add any new conditional CI step to `HEAVY_STEPS`.
- [x] T014 Full local loop; a PR when the founder says push.

## Release (founder)

- [x] T015 `staging-status` exit 0 (or the founder's choice of what to fold in, R2); plan PR 4; read it line by line; apply.
  Done 2026-11-07: an `INFRA` apply from `01325995` (exit 0 before and after).
- [x] T016 Invoke the Lambda once by hand; see an email with today's findings (expect #214 and the break-glass images, R3).
  Done 2026-11-07: invoked by hand (recorded in `environments.md`); T017's three emails then showed each kind of message arriving.
- [x] T017 SC-002 and SC-004: break each check once on purpose, and deny one read, and see each email; return each to OK.
  Done 2026-11-07 (`docs/ops/staging-freshness.md`, "Rehearsing it"): an extra alarm (state 2, "1 finding"), a denied read (SC-004,
  "check incomplete"), a denied publish (the `freshness-check-failing` alarm); each put back, `staging-status` exit 0 after. States 1 and 6
  are recorded when they occur on their own; 3 to 5 by their refusals (SC-002 as reworded). Still unseen: `freshness-check-missed`.
- [x] T018 Facts file and `environments.md` updated in a docs PR (alarm count plus 2). SC-001 runs for 14 days.
  Done: #305 (2026-11-07), and #315 after the second `INFRA` apply that evening (`e6050644`, #313). SC-001's 14 days started
  2026-11-07 and are still running.
