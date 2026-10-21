# Implementation Plan: Only the image CI built and scanned can be deployed (INF-03)

**Branch**: `docs/spec-002-signed-image-release` (this document); one `feat/…` or `chore/…` branch per slice | **Date**: 2026-10-20 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/002-signed-image-release/spec.md`

**Status**: **Approved by the founder 2026-10-20**, with the recommended D1–D5 (see "Founder decisions"). Slice 1 may start; each slice is still its own draft PR, merged only on the founder's word.

## Summary

The `image` job already builds, scans and rehearses one OCI archive. A new `release-image` job runs on pushes to `main`, only after `image` passes. It pushes that same archive to ECR without rebuilding and checks the registry's digest against the one `image` recorded. It then signs the digest with an asymmetric AWS KMS key through cosign, with no transparency-log upload. Before any apply that sets `api_image`, the operator verifies the signature with the KMS public key, and `check-plan` stage C refuses a digest without a verification record. The key, the GitHub OIDC trust and the release role are Terraform, written and not applied. The job skips itself until the founder sets the role variable.

## Technical Context

**Language/Version**: GitHub Actions YAML; Node 22 scripts (`scripts/staging/*.mjs`, `node:test`); Terraform 1.16.5, AWS provider `~> 6.67`

**Primary Dependencies**:
- `cosign`: exact version and checksum fixed in slice 2. The default transparency-log upload is turned off.
- An OCI copy tool that preserves digests (`crane` or `skopeo`, chosen in slice 2): exact version and checksum.
- `aws-actions/configure-aws-credentials`: pinned by SHA.

**Storage**: ECR (existing repository, `registry.tf`), signatures as OCI 1.1 referrers; verification records as JSON next to the plan file, never committed

**Testing**:
- `test:ci-config` (workflow text guards) and `test:infra` (Terraform text guards), each rule with a broken copy.
- `terraform test` (mock providers).
- A local OCI registry (`registry:2`, digest-pinned) for push-and-verify with a **file** key. The KMS signer is proved only at first apply.

**Target Platform**: GitHub-hosted `ubuntu-24.04` runners; AWS account of the stack (nothing applied before the BAA)

**Constraints**:
- No repository secret.
- `id-token: write` on one job only.
- Nothing written to a public log.
- The required checks stay green while the path is dormant.
- Strict up-to-date merges (#197) mean each slice is re-run after other merges.

**Scale/Scope**:
- One new job and one new step in `image`.
- One KMS key, one OIDC provider (or reuse), one role.
- One verify script, plus changes to `check-plan` and two docs.

## Constitution Check

| Principle | How this plan meets it |
|---|---|
| I. Plan first, approved by the founder | This plan is the gate. Each slice is its own draft PR, and none starts before approval. |
| II. Synthetic data only; secrets never leave their place; nothing applied in AWS | The private signing key never leaves KMS. CI holds a short-lived OIDC credential, not a secret. Nothing is applied: Terraform is written and tested with mock providers only, and the job is dormant until the founder acts. Images hold code, not records. |
| III. Inbound content is untrusted | The registry's answer (the digest after push) is compared with CI's own record, not trusted. A verification record is evidence that is re-checked, not configuration. |
| IV. Tests earn their keep | Every refusal has a positive control in the same run: a signed digest passes, and an unsigned one, one signed with another key and a rebuild are refused. Every guard rule has a broken copy. The transparency-log control proves no upload is even attempted. |
| V. Report outcomes faithfully | Each slice records in `docs/verification/signed-image-release.md` what was proved locally (file key, local registry) and what waits for the first apply (KMS signer, ECR lifecycle and referrers, Fargate pulling an index with attestations). |
| Change constraints | Actions SHA-pinned; tool binaries pinned by checksum; `test:ci-config` after `.github/`; `test:infra` after Terraform. No migration. |

**Gate result**: passes. **One deliberate exception** to a standing rule: `id-token: write` on the `release-image` job, and only there (guarded).

## Project Structure

### Documentation (this feature)

```text
specs/002-signed-image-release/
├── spec.md
├── plan.md      (this file)
└── tasks.md
docs/verification/signed-image-release.md   (created by slice 1)
```

### Source Code (repository root)

```text
infrastructure/terraform/
  signing.tf                     # slice 1: KMS signing key, OIDC provider (or reuse), release role
  signing.guard.test.mjs         # slice 1
  registry.tf                    # slice 1: lifecycle rule keeps an image's signature with it
  profiles.tftest.hcl            # slice 1: new runs
.github/workflows/ci.yml         # slice 2: image records the digest and uploads the archive on main; release-image job
.github/ci/release.test.mjs      # slice 2: workflow guards
scripts/staging/verify-image.mjs # slice 3: cosign verify + verification record
scripts/staging/check-plan.mjs   # slice 3: stage C needs a matching record
docs/ops/image-push.md, docs/ops/ci-cd.md, docs/STATUS.md
```

## Design

### Principals

| Principal | Can | Cannot |
|---|---|---|
| `release-image` job (OIDC, `main`, release environment) | push to the one ECR repository; `kms:Sign` / `kms:GetPublicKey` on the signing key | read or decrypt anything; use any other key; touch any other repository |
| Operator who applies | `kms:GetPublicKey` / `kms:Verify`; read ECR | `kms:Sign` (the key policy grants it to the role only) |
| Any pull-request job | nothing in AWS: no `id-token`, and the trust policy pins `ref` and the environment | |

### Trust policy (FR-002)

AWS documents these GitHub claims as condition keys (IAM user guide, "Available keys for AWS OIDC federation", GitHub tab, read 2026-10-20). The policy uses the **immutable IDs** AWS recommends over names:

```text
token.actions.githubusercontent.com:aud                 = sts.amazonaws.com
token.actions.githubusercontent.com:repository_id       = <numeric id>        (variable)
token.actions.githubusercontent.com:repository_owner_id = <numeric id>        (variable)
token.actions.githubusercontent.com:ref                 = refs/heads/main
token.actions.githubusercontent.com:environment         = <release environment>   (D1)
token.actions.githubusercontent.com:job_workflow_ref    = <owner>/<repo>/.github/workflows/ci.yml@refs/heads/main   (assumption A1; fallback: workflow = "ci")
```

### The release job (FR-004, FR-005)

1. The `image` job writes `api.oci.tar` as today. It also computes the OCI index digest from the archive's `index.json` and exposes it as a job output. On a push to `main` only, it uploads the archive with one-day retention.
2. `release-image`:
   - `if: github.event_name == 'push' && github.ref == 'refs/heads/main' && vars.<ROLE_VARIABLE> != ''`, with `needs: image` and `environment: <D1>`;
   - `permissions: { contents: read, id-token: write }`.
3. The job steps:
   1. Download the archive.
   2. Assume the role (OIDC).
   3. Log in to ECR.
   4. Push the archive with digest preservation, under the tag `git-<12-char sha>`.
   5. Read the digest back with `aws ecr describe-images`, and fail if it differs from the recorded one.
   6. `cosign sign --key awskms:///alias/<name>-image-signing --use-signing-config=false --tlog-upload=false <repo>@<digest>`.
   7. Write the digest and tag to the job summary.

### Verification (FR-007)

`scripts/staging/verify-image.mjs <api_image>` runs `cosign verify --key awskms:///alias/… --insecure-ignore-tlog <api_image>`. It writes `verified-image.json` (digest, key ARN, time, cosign version) next to the saved plan. *As built (slice 3, founder option (a) 2026-10-21):* `verify-image.mjs --name-prefix <p> --environment <e> <api_image> [<api_migrate_image>]` resolves the stack's alias to the key ARN with `kms describe-key` and verifies against the ARN. `check-plan` binds the record to the plan's own alias `alias/<name_prefix>-<environment>-image-signing` and to the image's account and Region. `check-plan` stage C reads it and requires `digest == api_image` (and `api_migrate_image` when set). Break-glass is `--unsigned-break-glass "<reason>"`: refused for production, recorded in the file and printed loudly.

### Rollout: slices (each its own draft PR off `main`, never stacked, merged in order)

| Slice | Content | Done when |
|---|---|---|
| 1 | Terraform: key, OIDC provider (create or reuse), role, lifecycle rule fix; guards; `terraform test` | all guards with broken copies; plans under both profiles; nothing applied |
| 2 | CI: digest output and archive upload on `main`; `release-image` job; workflow guards; local proof with a file key and a local registry | SC-002 and SC-003 tests; job shown skipped on `main` after merge (SC-004) |
| 3 | `verify-image.mjs`, `check-plan` stage C, break-glass; `image-push.md` and `ci-cd.md` rewritten | SC-001 five cases; docs state the one credential exception exactly |
| Founder | Create the release environment (D1); after the first apply, set the role variable; push to `main` once; verify | first signed digest verified; A1–A3 confirmed and recorded |

## Founder decisions (only the founder can make these)

**Decided 2026-10-20** (founder, verbatim): *"Approve the INF-03 plan with the recommended D1-D5 (image-release env limited to main, no reviewer; create the OIDC provider unless a variable names one; keep non-production break-glass; annual manual rotation; lifecycle decided in slice 1)."*

- **D1 Release environment.** Its name (recommended: `image-release`) and its protection rules. Recommended: deployment branches limited to `main`, with no required reviewer, because the job only pushes and signs and deploying is still a separate, manual apply. A required reviewer would add a human gate per merge at the cost of one click.
- **D2 OIDC provider.** Create it in this stack, or reuse an existing one if the account has it. Unknown until AWS access returns (A4). Recommended: a variable, empty by default, which creates it.
- **D3 Break-glass.** Keep an unsigned override for non-production (recommended, US5), or refuse unsigned images everywhere.
- **D4 Rotation cadence.** Recommended annually, and at once on suspicion. It is manual because KMS does not rotate asymmetric keys.
- **D5 Lifecycle.** If referrers count toward "keep the last 10", raise the count to 20, or keep images by tag prefix (recommended: keep the last 10 tagged `git-*` and expire untagged artifacts only when their subject is gone, if ECR supports it). Decided in slice 1 from what ECR is shown to do.

## Not touched by this plan or PR

- No change to `ci.yml`, Terraform, scripts or AWS in this PR: spec only.
- INF-06 (DATA-01 slice 2 dependency) and the other audit items.
- PR #207 and #208. Slice 2 builds on #207's pins (the cosign and copy-tool pins follow the same rules), so it starts after #207 merges.

## Complexity Tracking

| Violation | Why needed | Simpler alternative rejected because |
|---|---|---|
| `id-token: write` on one CI job (the guard says no job may request a write permission) | OIDC is how CI proves it is CI without a stored secret | A stored key or access key is a long-lived secret in GitHub. Keyless Sigstore publishes the repository's identity. Manual signing re-creates INF-03 |
| An asymmetric KMS key without automatic rotation (every other key's guard demands rotation) | KMS supports automatic rotation only for symmetric keys | Symmetric keys cannot produce a signature anyone can verify with a public key |

## Changes during slice 2 (2026-10-21)

Found by running the tools, not assumed. Recorded in `docs/verification/signed-image-release.md`:

- **cosign 3 needs two flags.** `--tlog-upload=false` alone is refused ("not supported with signing config"). Without it, cosign `POST`s to the public Rekor log. The release signs with `--use-signing-config=false --tlog-upload=false`.
- **Pushing the archive needs `crane push <layout>` without `--index`.** `--index` wraps the layout's `index.json` in a new index, so the registry would hold a different digest from the one scanned.
- **The `image` job already uploaded the archive on every run** (`api-image-with-attestations`, one day). No new upload step was needed.
- **Trivy and the rehearsal were scanning a second build, and it was not the same image.** In a config diff, layers 7–10 (`COPY /output/ ./` onward) of the loaded build differed from the archive's. The image job now builds once and loads the archive's own linux/amd64 image (`load-archive-image.sh`: local registry, `crane pull` to a Docker tarball, `docker load`, then a config-digest check). A rebuilt control image is refused.
- **The release commands are rehearsed on every pull request** (`release-rehearsal.sh`, local registry, throwaway key, every outbound proxy closed). Originally this was only a local proof.
