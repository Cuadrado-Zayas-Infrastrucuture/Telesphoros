# Signed image release (INF-03): verification record

`specs/002-signed-image-release/` (spec, plan and tasks in PR #209; plan approved by the founder 2026-10-20, with the recommended D1–D5). This file records what each slice ran, what it showed, and what waits for the first apply.

## Slice 1: signing key, GitHub OIDC trust, release role (T001–T007), 2026-10-20

**Scope.** `infrastructure/terraform/signing.tf` (new), `registry.tf` (two preconditions and the lifecycle rule), their guards and `terraform test` runs. **Nothing is applied in AWS.** The resources exist in a plan only when API hosting is on and the three GitHub repository values are set. No GitHub setting was changed.

**What the Terraform now says.**

| Piece | Setting |
|---|---|
| Signing key | `ECC_NIST_P256`, `SIGN_VERIFY`, profile deletion window (7 days synthetic, 30 production), no rotation flag (KMS cannot rotate an asymmetric key; D4 is manual, annual). Depends on the role, because its policy names the role |
| Key policy | Account administration; an explicit **Deny** of `kms:Sign` to every principal whose ARN is not the release role's; the role may `Sign`, `GetPublicKey` and `DescribeKey` |
| OIDC provider | Created only when `github_oidc_provider_arn` is empty (D2); no thumbprint (optional in AWS provider `~> 6.67`, checked in the provider schema) |
| Trust policy | Six `StringEquals` conditions: `aud`, `repository_id`, `repository_owner_id`, `ref = refs/heads/main`, `environment = image-release` (D1), `job_workflow_ref = <repo>/.github/workflows/ci.yml@refs/heads/main` |
| Role permissions | `ecr:GetAuthorizationToken` (`*`, as the API requires); push and read-back on the API repository only, no delete or reconfigure; `kms:Sign`, `GetPublicKey`, `DescribeKey` on the signing key only |
| Registry preconditions | The three GitHub values are set together or not at all. **Production with API hosting requires the release path** |
| Lifecycle (D5) | "Keep the last 10" now counts **tagged** images only (`tagPatternList = ["*"]`) |

**Why D5 is that rule.** The AWS ECR user guide ("Lifecycle policy evaluation rules", read 2026-10-20) says reference artifacts are expired within 24 hours of their subject image. AWS's OCI 1.1 launch post (2024) says reference artifacts that refer to an active image are protected from lifecycle deletion. Neither says whether a referrer counts toward `imageCountMoreThan`. Counting tagged images only removes the question: cosign stores its signature as an untagged OCI 1.1 referrer when the registry supports the referrers API (ECR does, since June 2024). Slice 2 pins cosign's referrers mode so that no tagged signature appears.

**Tests.**

| Check | Result |
|---|---|
| `signing.guard.test.mjs` (new) | Passes. **21 controls**, each a broken copy that is reported. A script confirmed that every control's "from" text matches the real file |
| `registry.guard.test.mjs` | Passes; it now requires the tagged rule, plus a new control (`tagStatus = "any"` is reported) |
| `profile.guard.test.mjs` ratchet | `signing.tf` uses `local.kms_deletion_days` once, as every other key does |
| `pnpm test:infra` | **126/126** (+2) |
| `terraform test`, main root | **45/45** (+3 runs). The default plan has no key, role or provider. Production with hosting has an ECC P-256 `SIGN_VERIFY` key with a 30-day window, the role, the provider, and exactly the six trust conditions. A named provider is reused, not created, and the synthetic key gets 7 days. Half a configuration is refused, and so is production hosting without the release path |
| `terraform test`, state root | 22/22 (unchanged) |
| `fmt -check -recursive`, `validate`, tflint (CI's `.tflint.hcl`) | Clean on both roots; lockfiles untouched |

**Defect injection on the Terraform itself.** Each file was restored byte-identical afterwards.

| Break | What went red |
|---|---|
| Production precondition weakened (`… \|\| var.enable_api_hosting`) | `refuses_production_hosting_without_the_signed_release_path` |
| Half-configuration precondition made trivially true | `refuses_half_a_github_repository_configuration` |
| OIDC provider created even when one is named | `image_release_reuses_an_existing_oidc_provider` |
| Trust pinned to `refs/heads/develop` | `production_hosting_on` (trust conditions) |
| Release path on without the repository IDs | `default_variables_plan` |

A first attempt replaced the preconditions with `condition = true`. Terraform rejects that as invalid configuration, so the suite failed **for the wrong reason**. Those two mutants were redone with valid weakenings, and each then failed exactly its own run.

**Not verified (waits for the founder's first apply, T019–T021):**
- that AWS accepts the key policy with the Deny and the role principal;
- that the trust policy admits the real job: assumption A1, `job_workflow_ref` for a non-reusable workflow;
- that cosign's KMS signer works with ECC P-256 (A2);
- how ECR treats the signature artifacts in practice (A3);
- whether the account already has a GitHub OIDC provider (A4: if it does, set `github_oidc_provider_arn`, or the apply fails on "already exists").
