# Releasing onto running synthetic staging

**Status: the scripts and their tests exist for every step (spec 027, PR 3a and PR 3b); no release has run the verification, frontend and
state-backup scripts yet.** Synthetic data only. Spec:
[specs/027-staging-freshness](../../specs/027-staging-freshness/). What is applied now: [environments.md](environments.md).

Releases before this one ran from copies of scripts in `~/telesphoros-private/release-<commit>/`, each edited for its release. Two things went
stale that way: the var file (one folder still named the first image) and the release check, which was widened each time to expect other
people's merged Terraform. The scripts in `scripts/staging/release/` replace those copies. Their live values come from the private
`~/telesphoros-private/staging/stack.env` (see the header of `lib.sh`); a release's outputs go to `~/telesphoros-private/releases/<commit>/`.

## What is fixed now

| Then | Now |
| --- | --- |
| Each release used the var file of the release before it, found by reading folders | **One var file:** `~/telesphoros-private/staging/current.tfvars` and its `.sha256`. A plan refuses it if it was edited by hand, or if the image it names is not what ECS runs. After an IMAGE apply exits 0, that release's var file becomes the current one |
| The release check was edited to accept that release's other changes | **Fixed shapes** (`release-check.mjs`): MIGRATE changes the migration task definition only, IMAGE the task definitions and the two services only. Anything else is refused: merged Terraform goes out first as its own **INFRA** plan |
| Any session could plan, and a saved plan could be applied after another apply | **A claim** (`claim.sh`): one owner plans and applies at a time. **A record next to each plan**: the state serial and lineage, the clone HEAD, the var file's and the plan's sha256. `apply.sh` refuses a plan whose record does not match the stack now, and Terraform refuses it too ("Saved plan is stale", rehearsed in `release-rehearsal.test.mjs`) |
| The apply script was edited to pin the plan's hash | `apply.sh` takes the hash as an argument, typed after reading the plan |
| The image and migration scripts were copied and re-pinned each release: the commit, the paths, the reason for an unsigned image, and the exact pending migrations | **`image.sh` and `migrate.sh`** take the commit. The reason is a file you write per release. The pending migrations must be exactly those at the commit after `newestMigration` in `staging-expected.json` on `origin/main` (`migration-pending.mjs`); only a rerun after an interrupted `migrate-up` may find fewer |
| The verification, frontend and state-backup scripts were copied too, with the hosts, the alarm count and a backup serial written in | **`verify.sh`, `frontend.sh` and `state-backup.sh`** read what to expect from `current.tfvars`, the hosts from `stack.env` (`API_BASE_URL`, `APP_URL`) and the serial from the IMAGE plan's record (the INFRA plan's, after an INFRA apply alone). The frontend is built with the assessment exactly when `current.tfvars` switches it on, and published only after a verification newer than the last apply |
| A Lambda went out as whatever `dist` the clone last built: Terraform zips the folder as it finds it | **Every plan builds each Lambda** in the clone first (`build_lambdas` in `lib.sh`): a frozen install, an emptied `dist`, umask 022 so the function can read each file, and the zips recorded next to the plan (`PLAN.bundles`); `apply.sh` refuses a zip that changed since. The first plan after this may show the password-change notifier's function changing once, if the deployed zip was built from other source or with other file modes: that change goes out in an INFRA plan, read like any other |
| A switch that is a Terraform variable could only go in by editing the canonical var file by hand | **One-flag modes**, same image, one reviewed variable, the API task definition and its service only: `FENCE-CLOSE` / `FENCE-OPEN` for medication recording ([medication-fence-transitions.md](medication-fence-transitions.md)) and `ASSESSMENT-ON` / `ASSESSMENT-OFF` for the synthetic assessment ([synthetic-assessment-switch.md](synthetic-assessment-switch.md)) |

## The steps

1. `scripts/staging/staging-status.sh` (spec 027, PR 2): read its table. Anything merged and not applied goes out first, as step 3 with INFRA.
2. `scripts/staging/release/claim.sh take NAME "reason"`. Every later step runs with `CLAIM_OWNER=NAME`. If `take` refuses,
   `claim.sh show` names the holder: ask them, and never plan from another session's pin or saved plan.
3. INFRA, only if step 1 listed merged Terraform: `plan.sh INFRA COMMIT`, read the plan text line by line, then `apply.sh INFRA COMMIT SHA256`.
   A plan whose only change is an output prints `Changes to Outputs:` and no `Plan:` line: INFRA accepts it, and it goes out first, because MIGRATE and IMAGE refuse any output change.
   When the release stops there (an INFRA apply alone), back the state up with `state-backup.sh BACKUP COMMIT INFRA`, then the Drive copy.
4. The image, unsigned under break-glass ([image-push.md](image-push.md)): write the reason, one line, to
   `~/telesphoros-private/releases/COMMIT/break-glass-reason.txt`, then `image.sh BUILD COMMIT`. It needs CI's image job green on COMMIT,
   builds and rehearses in `<clone>-release-<commit8>`, waits for ECR's scan, and writes `verified-image.json`, then `new_image.txt` last.
5. `plan.sh MIGRATE COMMIT`, read it, `apply.sh MIGRATE COMMIT SHA256`. Then `plan.sh IMAGE COMMIT` and read it **before migrating**: it needs
   only the MIGRATE apply, and `migrate.sh` refuses to start without this release's IMAGE plan, recorded (so it passed the release check) and
   still matching the stack. Then `migrate.sh MIGRATE COMMIT`, only while nobody uses staging: it checks the pending migrations, the idle
   window and takes an RDS snapshot before `migrate-up`, and writes `migrate-status.txt` saying `pending: (none)`. Last, it keeps the newest 3
   pre-migration snapshots and deletes older ones (`prune-snapshots.sh`; a failure there is a warning, not a stopped release; run it alone
   without `--yes` to see what it would delete). With nothing to migrate it records that and takes no snapshot. **From `migrate-up` until the IMAGE apply, staging is down**: the running API answers 503 on
   `/api/v1/ready` to a schema it does not know, and that is the load balancer's health check (two hours on 2026-11-08, when the IMAGE plan
   was refused after migrating).
6. `apply.sh IMAGE COMMIT SHA256` with the IMAGE plan you read, right after `migrate.sh`. When its log ends `== apply exit status: 0`, `current.tfvars` is this release's.
   Then `verify.sh IMAGE COMMIT` (read-only). A hold right after the apply means old tasks are still stopping: run it again in five minutes.
6a. Only when this release turns the synthetic assessment on: `plan.sh ASSESSMENT-ON COMMIT OPERATION_ID`, read it, `apply.sh ASSESSMENT-ON COMMIT SHA256 OPERATION_ID`
   ([synthetic-assessment-switch.md](synthetic-assessment-switch.md)). It refuses to plan until this release's IMAGE apply finished, migrations are complete and
   the running image has a verification record: a signature, or a break-glass record with a written reason. `ASSESSMENT-OFF` takes it away again and waits for nothing.
   After each such apply, `verify.sh ASSESSMENT-ON|ASSESSMENT-OFF COMMIT OPERATION_ID`.
6b. `frontend.sh DRY COMMIT`, read `publish-dry.txt`, then `frontend.sh PUBLISH COMMIT`. Both refuse until a verification newer than the last apply passed.
6c. `state-backup.sh BACKUP COMMIT` (three passphrase prompts), then the Drive copy and its round trip.
7. `staging-status.sh` again, then update `docs/ops/staging-expected.json` and [environments.md](environments.md) in one pull request.
   Its `newestMigration` is what the next release's `migrate.sh` counts from: until that pull request merges, the next migration step refuses.
8. `claim.sh release NAME`.

Every plan is read as text before its apply. The checks refuse shapes; they do not approve a plan.
