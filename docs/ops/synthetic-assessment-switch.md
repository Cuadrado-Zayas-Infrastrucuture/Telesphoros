# Switching the synthetic assessment on and off (spec 032 S3, PR 3c-3a)

Date: 2026-11-04. Synthetic data only. The scripts and their tests exist; **nothing has been planned or applied against staging**. Plan:
[pgx-synthetic-assessment.md](../design/plans/pgx-synthetic-assessment.md). The recipe around it: [staging-release.md](staging-release.md).

## What it is

`synthetic_assessment_enabled` is a Terraform variable that defaults to off (`api-compute.tf`, PR 3c-2). Turned on in the synthetic profile it adds two
settings to the API task and nothing else: `SYNTHETIC_ASSESSMENT=enabled` and `SYNTHETIC_KNOWLEDGE_DIR=/app/synthetic-knowledge` (the directory the image carries,
PR 3c-1). With them the API opens the structured preview, `POST /reports/:id/structured-assessment` and the two evaluation reads (PR 3a), and the staged
frontend, if it was published with `--with-synthetic-assessment`, shows the button.

The release recipe could not set it: the canonical var file `current.tfvars` is hashed and refuses hand edits, and an IMAGE plan may differ from it by exactly
the two image lines. So the switch has its own two modes, built like the medication fence (`FENCE-CLOSE` / `FENCE-OPEN`) and sharing its code:

| Mode | Variable written | Task definition before, after | Waits for |
| --- | --- | --- | --- |
| `ASSESSMENT-ON` | `synthetic_assessment_enabled = true` | neither setting, then both | this commit's IMAGE apply (`i-apply.txt` ends `exit status: 0`), `migrate-status.txt` saying `pending: (none)`, and a **signature** record for the running image (`verified-image.json`, the same check `FENCE-OPEN` makes) |
| `ASSESSMENT-OFF` | `synthetic_assessment_enabled = false` | both settings, then neither | nothing beyond the claim, the clone at the commit and the identity: it is the way back |

## Commands

```sh
CLAIM_OWNER=NAME scripts/staging/release/plan.sh ASSESSMENT-ON COMMIT on-001
# Read the saved plan text and the archived source/target variable diff; approve that exact plan hash.
CLAIM_OWNER=NAME scripts/staging/release/apply.sh ASSESSMENT-ON COMMIT PLAN_SHA256 on-001

CLAIM_OWNER=NAME scripts/staging/release/plan.sh ASSESSMENT-OFF COMMIT off-001
CLAIM_OWNER=NAME scripts/staging/release/apply.sh ASSESSMENT-OFF COMMIT PLAN_SHA256 off-001
```

Operation ids are 1 to 48 lower-case letters, digits or hyphens. Each attempt has its own private `releases/COMMIT/assessments/OPERATION_ID/` folder
(`source.tfvars`, `ae.tfvars` or `ad.tfvars`, the binary and readable plan, its JSON projection, the plan record and the apply log); an old one is never
overwritten, and a started apply cannot be started again. `ae` is the switching-on prefix and `ad` the switching-off one.

## What the checks prove

- **The var file:** only `synthetic_assessment_enabled` may change, as a literal boolean, appended when absent; every other byte of `current.tfvars` is kept, including
  the medication line (`fence-vars.mjs`, tested both ways round).
- **The plan** (`release-check.mjs` → `fence-plan.mjs`, one engine for the medication fence and this): complete, applicable, no drift outside the reviewed harmless
  list, no output change, synthetic `us-east-2` staging, both image variables unchanged and equal to the running image, exactly two resources changed: the API task
  definition replaced and its service moved in place. In the task definition only the two settings differ, with exactly the values Terraform writes (one constant,
  `ASSESSMENT_SETTINGS`, which the Terraform guard compares with `api-compute.tf`). Both or neither: the application refuses either alone. No secret or environment
  file may carry either name. A medication change, an image change or any other setting in the same plan is refused, and the medication fence refuses a plan that
  also moves the assessment.
- **The apply:** the plan hash typed after reading, the plan record (state serial and lineage, clone HEAD, source and target var hashes), the claim, the identity, the
  release gates again for `ASSESSMENT-ON`, and a one-start lock. After a successful apply the generated var file becomes the canonical one, but only if it is still
  byte-identical to what was reviewed.

## What it does not prove

- That AWS accepts the plan, that the API starts with the settings, or that the assessment works end to end: the offline tests use invented plan JSON and stubbed
  Terraform. The first real use is the founder-run release (PR 3c-3); the recipe's verification step (a private script until spec 027 PR 3b ports it) and the walkthrough are the proof.
- That the image really contains `/app/synthetic-knowledge`: the hosted `image` job's rehearsal runs the smoke script in the built image (PR 3c-1), and the record
  here is only that the release's image was signed.
- Production: the variable is refused outside the synthetic profile, and these modes accept only synthetic staging plans.

## Rolling back

`ASSESSMENT-OFF` removes both settings and rolls the API to a new task-definition revision on the same image; no image change, no migration. Evaluations already
stored stay stored (the ledger is append-only); the routes answer 503 again. If an `ASSESSMENT-ON` apply fails part-way, preserve the claim and the operation folder,
run `staging-status.sh`, and tell Claude before planning again.
