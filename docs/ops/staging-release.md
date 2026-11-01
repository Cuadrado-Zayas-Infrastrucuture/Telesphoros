# Releasing onto running synthetic staging

**Status: the scripts and their tests exist (spec 027, PR 3a); no release has run through them yet.** Synthetic data only. Spec:
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

## The steps

1. `scripts/staging/staging-status.sh` (spec 027, PR 2): read its table. Anything merged and not applied goes out first, as step 3 with INFRA.
2. `scripts/staging/release/claim.sh take NAME "reason"`. Every later step runs with `CLAIM_OWNER=NAME`.
3. INFRA, only if step 1 listed merged Terraform: `plan.sh INFRA COMMIT`, read the plan text line by line, then `apply.sh INFRA COMMIT SHA256`.
4. The image. Until PR 3b ports it, build and record it with the last release folder's `release-image.sh`, writing `new_image.txt` and
   `verified-image.json` into `~/telesphoros-private/releases/COMMIT/`.
5. `plan.sh MIGRATE COMMIT`, read it, `apply.sh MIGRATE COMMIT SHA256`. Then migrate (until PR 3b, the last folder's `release-migrate.sh`),
   which writes `migrate-status.txt` saying `pending: (none)`.
6. `plan.sh IMAGE COMMIT`, read it, `apply.sh IMAGE COMMIT SHA256`. When its log ends `== apply exit status: 0`, `current.tfvars` is this release's.
7. `staging-status.sh` again, then update `docs/ops/staging-expected.json` and [environments.md](environments.md) in one pull request.
8. `claim.sh release NAME`.

Every plan is read as text before its apply. The checks refuse shapes; they do not approve a plan.
