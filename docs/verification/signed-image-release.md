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

## Slice 2: CI pushes the scanned archive and signs it (T008–T012), 2026-10-21

**Scope.** `.github/workflows/ci.yml` (the `image` job, and a new `release-image` job). Four scripts in `infrastructure/docker/`: `release-tools.sh`, `load-archive-image.sh`, `release-rehearsal.sh` and `release-image.sh`, plus `image-digest.mjs`. Guards in `.github/ci/`. **Nothing reached AWS:** `release-image` is skipped until the founder sets `IMAGE_RELEASE_ROLE_ARN`.

**Tools.** cosign **v3.1.3** (2026-08-06) and crane **v0.22.1** (2026-09-04), both at least two weeks old when pinned, each checked against the SHA-256 its release publishes. On Linux (`ubuntu:24.04`, linux/amd64), `release-tools.sh` installs both and checks their versions. With one checksum digit changed it refuses, and installs nothing. One run failed with curl exit 18 (a truncated download), which `--retry` does not retry; the script now uses `--retry-all-errors`.

**What running the tools showed** (each changed the design):

| Finding | Evidence | Consequence |
|---|---|---|
| **CI scanned a rebuild, not the archive it keeps** | Config diff of the real API image: layers 7–10 (`COPY /output/ ./`, the CA bundle, its check, the npm removal) of the second `--load` build had other digests than the OCI archive's | The second build is gone. `load-archive-image.sh` loads the archive's own linux/amd64 image (local registry, `crane pull` to a Docker tarball, `docker load`) and ends by comparing **config** digests. A fresh rebuild as control is refused (config `d93709b9…` vs `68c9e4f7…`) |
| `crane push --index` changes the digest | It wraps the layout's `index.json` in a new index: `84dd423a…` instead of `25282e0d…` | Push without `--index`. Guarded, and the rehearsal checks it as a control on every run |
| cosign 3 signs to the **public** Rekor log by default, even with a key | With every outbound proxy closed: `--use-signing-config=false --tlog-upload=false` signs. Without `--tlog-upload=false` it fails on `POST https://rek…`. `--tlog-upload=false` alone is refused by cosign 3 | Both flags, guarded. The rehearsal proves on every run that nothing public is contacted |
| Verification | Right key: exit 0. Other key: exit 1. Unsigned digest: exit 10 | All three in the rehearsal |
| `registry:3` has no referrers API, so cosign used a `sha256-<digest>` **tag** | `crane ls` showed the tag | ECR has the API. `release-image.sh` stops if such a tag appears, which turns assumption A3 into a hard check on the first real run |
| A pipefail plus `grep -q` race | The fallback-tag test failed 4 of 8 runs: `grep -q` exits early, `crane ls` dies of SIGPIPE, and pipefail turns a match into a miss. The same pattern was in `release-tools.sh`'s version checks | Output is captured first. A guard forbids `\| grep -q` in the three scripts, with a control that restores the race |
| A stub that did not behave like the real tool | The stub `crane auth login` did not read stdin, so the login pipe died of SIGPIPE at random (exit 141) | The stub reads stdin like crane. Then 15 of 15 runs passed |
| The archive was already uploaded on every run | `api-image-with-attestations`, one day | No new upload step |

**Tests.**

| Check | Result |
|---|---|
| `.github/ci/release.test.mjs` (new) | 9 tests, including **23 controls** (broken copies that must be reported). `release-image.sh` was run against stub `aws`/`crane`/`cosign`: it pushes under `git-<sha>` and signs with exactly `--key awskms:///alias/… --use-signing-config=false --tlog-upload=false` on the digest, then verifies. A rerun does not push again. It refuses a tag holding another image, a changed digest, a fallback tag, a failed verify, and malformed inputs (before any command runs) |
| `pnpm test:ci-config` | **172/172**. `guard.test.mjs` now allows exactly one write (`id-token` on `release-image`) and an after-merge job category. `supply-chain.test.mjs` likewise. The image-job guard requires the archive's image, not a second build |
| The image job, locally on the real API image | Docker guard 23/23. OCI build, digest, archive image loaded (config match), Trivy CRITICAL/HIGH 0 on that image, readiness, rehearsal **6/6 PASS**, release rehearsal all three PASS. No container left behind |
| actionlint 1.7.12, shellcheck | Clean |

One full-suite run hung for 14 minutes in `service-lifecycle.test.mjs` (watchdog timers) while the Mac slept: `uptime` advanced about 4 hours across it. Run alone at load 18: 8/8 in 11 s. Full suite again: 172/172.

**Not verified (first apply, T019–T021):** the release job against real ECR and KMS (assumption A1 on `job_workflow_ref`, A2 the KMS signer, A3 referrers on ECR), and that the job is shown **skipped** on `main` with the variable unset (SC-004, after merge).

## Slice 3: verify before apply (T014–T018), 2026-10-21

**Scope.**

- `scripts/staging/verify-image.mjs` (new), with its test;
- `scripts/staging/check-plan.mjs` stage C, with its test;
- docs: `image-push.md` (rewritten), `staging-plan-review.md`, `staging-rehearsal.md`, and the image break-glass log in `ci-cd.md`.

**Nothing reached AWS.** No Terraform or workflow changed. The founder chose option (a): a record file bound to the stack's key alias, not a re-verification inside `check-plan`.

**What it does.**

| Piece | Behaviour |
|---|---|
| `verify-image.mjs` | Refuses malformed images before running any tool: a tag, a tag plus digest, a non-ECR image, images from two Regions. Requires cosign 3. Resolves `alias/<name_prefix>-<environment>-image-signing` to its ARN (`kms describe-key`), which must be an enabled `ECC_NIST_P256` / `SIGN_VERIFY` key in the image's account and Region. Runs `cosign verify --key awskms:///<ARN> --insecure-ignore-tlog` on each image. Requires exit 0 **and** every signed payload's `docker-manifest-digest` equal to the digest. Writes the record only if every image passes, atomically; a failure leaves an earlier record untouched. Rejects unknown, repeated or empty options |
| Break-glass | `--unsigned-break-glass "<reason>"`: refused for `--environment production`. The reason must be one line of 10–300 characters. The record says `break-glass`. Neither cosign nor AWS runs; the reason is printed |
| `check-plan.mjs` C | Reads `verified-image.json` next to the saved plan. Refuses it when it is missing, unreadable, of another format, or for another environment. Refuses it when it lacks `api_image`, or `api_migrate_image` when set. Refuses a key alias that is not the plan's `alias/<name_prefix>-<environment>-image-signing`, a key ARN outside the image's account or the plan's Region, and cosign other than 3. A break-glass record is refused for a production environment or profile, and needs a reason. Record contents are never printed, except an accepted break-glass reason |

**Real cosign, not only stubs.** cosign v3.1.3 (darwin/arm64, the release checksum) ran against a local `registry:3` (the pinned digest), on the slice 2 OCI archive, with a file key:

- right key: exit 0, and `signedDigests` returned the one payload, naming the digest;
- another key: exit 1;
- an unsigned digest (the amd64 manifest inside the index): exit 10;
- the signed payload checked against that other digest: rejected.

The stubs' exit codes and output shape match these results. The KMS path (`awskms:///`) has **not** run (A2, first apply).

**Tests.**

| Check | Result |
|---|---|
| `scripts/staging/verify-image.test.mjs` (new; imported by `test:infra`) | 4 tests. Stand-in `cosign`/`aws` record every argument: the exact `describe-key` and `verify` commands, the key **ARN** (not the alias), the Region. 19 refusal cases: an unsigned image; another key; one of two images unsigned; a payload for another digest; cosign exit 0 with empty, `[]` or text output; cosign 2; a missing, non-P-256, encryption or disabled key, or a key in another Region; a tag; a tag plus digest; a non-ECR image; two Regions; no image. Each writes no record and leaves an earlier one byte-identical. 6 argument cases; 7 break-glass refusals |
| `scripts/staging/check-plan.test.mjs` | 7 tests (5 before). The existing stage C cases now pass a **valid** record, so each still fails for its own reason. 15 record refusals (SC-001), `api_migrate_image` refused when unverified and accepted when verified, break-glass refused for a production environment or profile. The CLI refuses a missing record, accepts a matching one, prints a break-glass reason, and never prints an unreadable record |
| Broken copies | 12 of 12 turned the suite red: the payload digest not checked; cosign's exit ignored; verify by alias; break-glass allowed in production in either script; a disabled key; any cosign version; `api_migrate_image` unchecked; the key alias unchecked; a missing record accepted; any format; the key ARN unchecked. The restored suite is green |
| The `verify` job, locally (Node 22.22.0) | install, typecheck, lint, test (backend 1747 passed, 256 skipped), build, `check:chunks`, `knowledge:verify --production`: all exit 0. `test:infra` **136/136**, `test:ci-config` **172/172** |
| gitleaks 8.30.1 | No leaks, in the changed directories and on the commit |

**Not run here:**

- `test:ig`: Java 21 is not installed on this Mac;
- the `terraform`, `terraform-lint`, service, image and browser jobs: no `.tf` file, workflow, image or application file changed.

**Not verified (first apply, T019–T021):**

- `verify-image.mjs` against real KMS and ECR;
- that an operator's IAM identity has `kms:DescribeKey`/`kms:GetPublicKey` through the key policy's account delegation;
- A1–A3.
