# Feature Specification: Clinical review before a release (RC)

**Feature Branch**: `feat/release-clinical-review`

**Created**: 2026-11-19

**Status**: Plan approved by the founder 2026-11-19 ("Approve, staging exception"), after choosing a release gate over a merge rule
("(c) Release gate"). Slice P0-B of the 2026-11-16 clinical UX and adoption audit (finding H12: an engine change merges with CI only and
no clinical approval).

**Input**: Both repositories' merge rules require 0 approvals and no code-owner review (`.github/rulesets/main.json:18,20`), because the
only maintainer cannot approve his own pull requests (`docs/ops/ci-cd.md:340-351`). About 23 merged pull requests in the 30 days to
2026-11-19 touched the clinical paths, so a required reviewer on every merge does not fit a clinical reviewer who is not a developer. The
point where engine output reaches clinicians is the release, so the review is required there.

## Decisions

- **D1, the gate is at the image step.** `image.sh` already knows the candidate commit and the running image before it pushes anything
  to ECR (its section 1); nothing in AWS has changed when it refuses. Merge rules are not changed. `CODEOWNERS` gains two lines in its clinical block (founder,
  2026-11-24, "Add them first"): `apps/backend/src/genomic-profile/` and `apps/backend/src/gene-modifiers/`, so the block names where clinical
  logic now lives. The rulesets require no code-owner review, so this changes who must review a release, not who may merge.
- **D2, the reviewer is Kevin.** Only the knowledge-signer key with id `kevin` (spec 033-14 SR-1: a signer's key id is that curator's
  handle) can approve. The founder's key, or any other, is refused.
- **D3, staging exception (founder, 2026-11-19).** On staging only, a release may go out without the review when the founder writes a
  reason, one line of 10 to 300 characters, as the unsigned-image reason already works. The record says it was an exception. Production
  has no exception.

## Requirements

| ID | Requirement |
| --- | --- |
| RC-1 | **Clinical paths, one list.** `knowledge/`, `packages/cpic-schema/`, `apps/backend/src/services/`, `apps/backend/src/genomic-profile/` (the genomic profile and its phenoconversion notices, specs 044 and 045), `apps/backend/src/gene-modifiers/` (the gene modifier lists, spec 045), `tests/clinical_scenarios/` and `docs/clinical-validation/`: the paths under "Clinical content and logic" in `.github/CODEOWNERS`. A test keeps the two lists equal. |
| RC-2 | **The base is what runs.** The base commit is `image.commit` in `docs/ops/staging-expected.json` at the candidate, and its `image.digest` must equal the image ECS is running (`running_image` in `lib.sh`). A note that disagrees, or a base that is not an ancestor of the candidate, refuses the release: a stale or edited note cannot hide changes. |
| RC-3 | **No clinical change passes on its own.** When no file under the clinical paths differs between base and candidate, the gate writes a record saying so and the release goes on. |
| RC-4 | **A clinical change needs a review record.** Otherwise the release needs `~/telesphoros-private/releases/COMMIT/clinical-review.json` (schema `clinical-review/1`) naming the base, the candidate and the changed clinical files, which must equal what the gate computes. |
| RC-5 | **Kevin signs it.** A review record carries an ECDSA P-256 signature (KMS `ECDSA_SHA_256`, DER, base64) over `telesphoros-clinical-review/1\n<base>\n<candidate>`. The tag differs from the knowledge signing message (`telesphoros-knowledge/1`), so neither signature can stand for the other. The gate verifies it against the public key of KMS alias `alias/telesphoros-staging-knowledge-signer-kevin`; a missing key refuses a review record and says so. |
| RC-6 | **The exception (D3).** On staging, a record with `exception.reason` (10 to 300 characters, one line) and no signature passes, and the gate prints that it is an exception. With the environment `production`, an exception is refused. |
| RC-7 | **Kept in git.** The record, or the gate's "no clinical change" record, is added in the release's step-7 facts pull request under `docs/ops/clinical-reviews/`. |
| RC-8 | **Signing needs nothing new.** `clinical-review.mjs message BASE CANDIDATE` writes the exact bytes; Kevin signs them with `aws kms sign` on his key, as `knowledge:sign` does; `clinical-review.mjs record ...` writes the record. No dependency is added. |
| RC-9 | **Production.** There is no production release recipe yet (`docs/ops/environments.md:14`). When one is written, it calls this gate with the environment `production`. |

## Acceptance tests (node --test, `pnpm test:infra`; a throwaway git history and P-256 keys made in the test)

| ID | Test | Must fail when |
| --- | --- | --- |
| T-1 | Only non-clinical files changed: passes, "no clinical change" record | a non-clinical change asks for a review |
| T-2 | A clinical file changed and no record: refused | the gate passes without a record |
| T-3 | A record signed by the reviewer key over this base and candidate, with the computed file list: passes | a valid review is refused |
| T-4 | Signed by another key (the founder's): refused | any signer is accepted |
| T-5 | A record for another base, or another candidate, or with an edited file list: refused | a review is moved to another release, or the list is not checked |
| T-6 | A signature over the knowledge tag, or over the right text with another tag: refused | the tag is not checked |
| T-7 | The note's digest differs from the running image, or its base is not an ancestor: refused | a stale note shortens the range |
| T-8 | Exception with a valid reason on staging: passes and says "exception"; on production: refused; reason too short, too long or two lines: refused | the exception reaches production, or any reason passes |
| T-9 | A review record when the reviewer key is missing: refused, naming the missing key | a missing key passes as valid |
| T-10 | RC-1's list equals the `CODEOWNERS` clinical block | the two lists drift |

## Out of scope

- Merge rules, `CODEOWNERS` and branch protection (the founder chose the release gate).
- Creating Kevin's KMS key: `knowledge_signers` is empty in staging (no `knowledge-signer` alias exists, read 2026-11-19), so until the
  founder names the signers and applies, every release with a clinical change uses the exception.
- What Kevin reviews and how (the diff, scenario tests): his clinical procedure, not this gate.
