# Feature Specification: Only the image CI built and scanned can be deployed (INF-03)

**Feature Branch**: `docs/spec-002-signed-image-release` (spec only; each implementation slice gets its own branch off `main`)

**Created**: 2026-10-20

**Status**: Approved 2026-10-20 (plan.md). The founder chose the signing method the same day: *"KMS signing, no public transparency log."*

**Input**: Security audit 2026-10-19, finding INF-03 (High, CVSS 4.0 7.5, CWE-345 and CWE-494; SSDF PS.2, PW.6). The rest of the release-integrity group is done: INF-05 in #197/#200; INF-11 and INF-17 in #207 (draft). INF-18 was accepted as a gap in #208 (draft).

Line numbers cite `main` `318232f`.

## The problem

The image that would run with access to PHI is not the image CI checked:

- **CI builds and scans an image, then throws it away.** The `image` job builds `api.Dockerfile` for linux/amd64 with an SBOM and provenance (`.github/workflows/ci.yml:1018-1021`, `push: false`), scans it with Trivy, and rehearses it. Nothing it built leaves the runner.
- **A person builds the deployed image again on a workstation and pushes it.** The documented path is `docker buildx build … --load` then `docker push` (`docs/ops/image-push.md:45,47`). That build can differ from CI's: another base-layer pull, a dirty Docker cache, or a modified workstation.
- **The registry scan is "a second look, not the gate"** (`image-push.md:64`). The only rule is a sentence: "Do not set `api_image` for an image whose CI `image` run was not green on the same commit."
- **Terraform accepts any ECR digest.** `api_image` is validated only as the shape `<account>.dkr.ecr.<region>.amazonaws.com/<repo>@sha256:<64 hex>` (`infrastructure/terraform/api-compute.tf:6-14`), and `scripts/staging/check-plan.mjs:55` checks only that the region matches. Nothing ties a digest to a CI run.

**Threat.** An attacker with the operator's workstation or Docker cache, or a malicious base layer pulled only there, ships an image that passed no gate. The Trivy gate, the SBOM and the rehearsal then describe a different artifact from the one running with PHI access. Today nothing is deployed, so exploitability is low. It becomes real at the first apply that sets `api_image`.

**Rule:** a digest may be deployed only if CI built it, scanned it, rehearsed it and signed it, and nothing outside AWS learns about it.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Only a CI-signed digest can be deployed (Priority: P1)

An operator sets `api_image` for a stage C apply. If that digest carries no valid signature from the image-signing key, the pre-apply check refuses it and names the digest. If it does, the check passes.

**Why this priority**: This is INF-03 itself.

**Independent Test**: Against a local OCI registry, an image signed with a test key passes the verify step, and an unsigned image with the same tag fails it. The same image signed with another key also fails. A plan with `api_image` set and no verification record is refused by `check-plan` stage C.

**Acceptance Scenarios**:

1. **Given** a digest pushed and signed by the `release-image` job, **When** the operator runs the pre-apply verification, **Then** it passes and records the digest, the key ID and the time.
2. **Given** a digest pushed by hand (break-glass) and not signed, **When** verification runs, **Then** it fails with "no signature from the image-signing key", and stage C is refused.
3. **Given** a digest signed by any other key, **When** verification runs, **Then** it fails.

---

### User Story 2 - The image deployed is byte-for-byte the image CI scanned (Priority: P1)

The `release-image` job pushes the OCI archive that the `image` job built and that Trivy and the rehearsal ran against. It never rebuilds.

**Why this priority**: Signing a rebuild would sign something nobody scanned. That would only move INF-03 from the workstation into CI.

**Independent Test**: The digest the `image` job records and the digest the registry reports after the push are equal, and the job fails when they differ. A control that rebuilds instead of copying gets a different digest and is refused.

**Acceptance Scenarios**:

1. **Given** a green `image` job on a push to `main`, **When** `release-image` runs, **Then** it pushes the same archive, compares the registry's digest with the recorded one, and signs only if they are equal.
2. **Given** the `image` job failed or was skipped, **When** the workflow continues, **Then** `release-image` does not run.

---

### User Story 3 - Nothing about the repository or its images leaves AWS and GitHub (Priority: P1)

Signing writes nothing to Sigstore's public transparency log (Rekor) and uses no public certificate authority (Fulcio). The repository is private: its name, workflow paths and image digests must not appear in any public log.

**Why this priority**: This is the founder's condition for choosing KMS (2026-10-20). Cosign uploads to the transparency log **by default even when signing with a key**: its own reference labels `cosign sign --key …` as "sign a container image and upload to the transparency log".

**Independent Test**: Sign with `--tlog-upload=false` while the transparency-log URL points to a closed local port. Signing succeeds, so no upload was attempted. The control drops the flag with the same closed URL and fails, which proves the URL would have been used.

**Acceptance Scenarios**:

1. **Given** the release job, **When** it signs, **Then** the command carries `--tlog-upload=false`, no Fulcio or OIDC-to-Sigstore exchange happens, and a guard refuses the workflow without the flag.
2. **Given** verification, **When** it runs, **Then** it uses `--insecure-ignore-tlog` and the KMS public key, and nothing else.

---

### User Story 4 - The release path is dormant until the founder turns it on (Priority: P2)

Nothing is applied in AWS before the BAA. The Terraform for the signing key and the CI role is written and tested but not applied. The `release-image` job skips itself while the repository variable naming the role is unset. It does not fail, so the required checks stay green.

**Why this priority**: The work can merge now without becoming a live credential path.

**Independent Test**: On a push to `main` with the variable unset, `release-image` reports skipped, the other required checks are unaffected, and no `id-token` is requested.

---

### User Story 5 - Break-glass still works and stays visible (Priority: P3)

If CI is down, a person can still push by hand (today's runbook). The image is unsigned, so stage C refuses it unless the operator passes an explicit, logged override that names the digest and a reason. The override never applies to production. It is recorded the way the break-glass ruleset edit is (`docs/ops/ci-cd.md`, "Break-glass").

---

### Edge Cases

- **Re-running a release.** The same digest is pushed again under an existing immutable tag. ECR refuses an existing tag with different content, but the same content under the same tag is allowed. The rerun must neither fail on that nor create a second signature that confuses verification. Verification accepts one or more signatures from the key on the subject digest.
- **The lifecycle rule** (`registry.tf:33-37`: keep the last 10, `tagStatus = "any"`) may count signature artifacts as images, or expire them separately from their subject. A slice must check, on a real or emulated registry, whether OCI 1.1 referrers count toward the 10, and must change the rule so that a kept image always keeps its signature.
- **Multi-manifest index.** The OCI archive carries the image plus SBOM and provenance attestation manifests (`sbom: true`, `provenance: mode=max`). The digest signed and deployed is the index digest, the same one ECS resolves. Verifying that ECS on Fargate runs an index with attestation manifests is a first-apply check.
- **The key is deleted or disabled.** Verification fails closed; nothing deploys. The key's deletion window is the profile's (`kms_deletion_days`).
- **Key rotation.** AWS KMS cannot rotate an asymmetric key automatically. Rotation means a new key, a new alias target and re-signing. Verification accepts the keys listed in a variable, newest first, and an old key is removed from the list only after every kept image is re-signed. The existing guards demand `enable_key_rotation = true` for every log key; the signing key needs an explicit, guarded exception.
- **A pull request from a branch or fork.** It never gets the role. The job runs only on `push` to `main`, and the role's trust policy also pins `ref`, the repository and the environment.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001** Terraform declares an asymmetric KMS key (`key_spec = "ECC_NIST_P256"`, `key_usage = "SIGN_VERIFY"`) with an alias. Its key policy allows `kms:Sign` only to the CI release role, and `kms:GetPublicKey` and `kms:Verify` to the operators who apply. It allows no `kms:Decrypt`, `kms:Encrypt` or `kms:GenerateDataKey*`.
- **FR-002** Terraform declares (or, when a variable names an existing one, reuses) the IAM OIDC provider for `token.actions.githubusercontent.com`, and a role `<name>-ci-image-release`. The role's trust policy requires all of the following, using the condition keys AWS documents for GitHub (retrieved 2026-10-20):
  - `aud` = `sts.amazonaws.com`;
  - `repository_id` and `repository_owner_id` (immutable IDs, not names);
  - `ref` = `refs/heads/main`;
  - `environment` = the release environment;
  - `job_workflow_ref` = this repository's `.github/workflows/ci.yml@refs/heads/main`.
- **FR-003** The role may: `ecr:GetAuthorizationToken`; the push actions on the one API repository only; `kms:Sign` and `kms:GetPublicKey` on the signing key only. Nothing else, and no wildcard resource except the one `GetAuthorizationToken` requires.
- **FR-004** The `image` job records the OCI index digest of the archive it built, scanned and rehearsed, and on push to `main` uploads that archive for one day.
- **FR-005** The new `release-image` job:
  - runs only on `push` to `main`, `needs: image`, uses the release environment, and is the **only** job with `id-token: write`;
  - skips itself when the role variable is unset;
  - pushes the archive without rebuilding, preserving its digest;
  - compares the registry's digest with FR-004's, and stops on a difference;
  - signs the digest with `cosign sign --key awskms:///alias/… --use-signing-config=false --tlog-upload=false` (cosign 3: the first flag is required for the second, and without the second it uploads to the public Rekor log; shown 2026-10-21);
  - holds no repository secret.
- **FR-006** Every tool the job runs is pinned: the actions by commit SHA, the cosign binary by version and checksum, the push tool by version and checksum.
- **FR-007** A pre-apply verification step (`scripts/staging/verify-image.mjs` or an equivalent runbook command) runs `cosign verify --key awskms:///… --insecure-ignore-tlog` on the exact `api_image` digest. It writes a verification record: the digest, the key ID, the time and the cosign version. `check-plan` stage C refuses a plan whose `api_image` has no matching record. `api_migrate_image` gets the same treatment.
- **FR-008** Break-glass (US5): an explicit `--unsigned-break-glass "<reason>"` path that is refused for `environment = "production"`, writes the reason into the record, and is listed in `docs/ops/ci-cd.md`.
- **FR-009** The guards:
  - `.github/ci` tests: `id-token: write` appears exactly once, on `release-image`; that job's trigger condition, `needs`, environment and `--tlog-upload=false`; no secret.
  - `infrastructure/terraform` guards: the key's spec and usage, its policy, the trust conditions of FR-002, and the role's permissions of FR-003.

  Every rule is proved by a broken copy.
- **FR-010** `docs/ops/image-push.md` is rewritten. CI pushes and signs; the manual push is break-glass only; the claim "CI still never holds cloud credentials" is replaced by an exact statement of the one exception.
- **FR-011** Nothing in this feature is applied in AWS, and no GitHub setting is changed by an agent. The founder creates the environment and sets the variable (plan.md, decisions).

### Key Entities

- **Image-signing key**: an asymmetric KMS key, ECC P-256, used only to sign image digests.
- **Release role**: an IAM role assumable only by the `release-image` job's OIDC token on `main` in the release environment.
- **Verification record**: a small JSON file per apply that cites the digest, the key ID, the verification time and the tool version. It is evidence, not configuration.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001** Stage C refuses 100% of these digests: unsigned, signed by a different key, signed for a different digest, and a tag instead of a digest. It accepts the CI-signed digest. All five cases are tests.
- **SC-002** On a test registry, the digest after push equals the digest the `image` job recorded. A rebuilt control differs and is refused.
- **SC-003** With `--tlog-upload=false` and an unreachable transparency-log URL, signing succeeds; without the flag it fails. Both are tests.
- **SC-004** On `main` with the role variable unset, `release-image` is skipped and every required check is still green (seen once on GitHub after merge).
- **SC-005** Every guard rule (FR-009) has a broken copy that turns it red.

## Assumptions

- **A1** `job_workflow_ref` is populated for a job that is not a reusable workflow, with the calling workflow's path and ref. AWS documents the key for "jobs using a reusable workflow". **If it is empty for our job,** the trust policy pins `workflow` = `ci` instead (also a documented key), together with `ref`, `environment` and the repository IDs. To be confirmed on the first real run, from the role's CloudTrail `AssumeRoleWithWebIdentity` event, not by printing the token.
- **A2** Cosign's AWS KMS signer accepts an `ECC_NIST_P256` / `SIGN_VERIFY` key. Sigstore's key-management page documents the `awskms:///` URI but not the supported key specs. Slice 2 proves the signing flow with a file key on a local registry. The KMS part is proved only at first apply, and the verification record says which.
- **A3** ECR serves OCI 1.1 referrers (supported since June 2024, `ListImageReferrers`), and cosign stores its signature as a referrer by default. Whether ECR's lifecycle counting and `IMMUTABLE` tags treat referrers as images is not documented in what was read. That is the lifecycle edge case above.
- **A4** Whether this AWS account already has a GitHub OIDC provider is unknown: there is no AWS access today. AWS allows one provider per URL per account, hence the "reuse" variable in FR-002.

## Alternatives considered

| Option | Why not |
|---|---|
| Keyless Sigstore (Fulcio + Rekor) | Writes the private repository's name, workflow path and digests to a public, permanent log. Rejected by the founder 2026-10-20 |
| GitHub artifact attestations | For private repositories they need GitHub Enterprise Cloud. The org is on the Team plan (checked 2026-10-20) |
| ECR managed signing (AWS Signer, since 2025-11) | Signs **whatever is pushed**, by anyone with push rights. A signature would prove "pushed to ECR", not "built and scanned by CI" |
| A cosign key stored as a GitHub secret | Puts a long-lived private key in GitHub. The CI guards forbid repository secrets, and a leaked key signs anything |
| Rebuild in CI and push | Signs a build nobody scanned. US2 forbids it |
| Restrict `api_image` to digests listed in a file CI commits | Needs CI write access to the repository, and proves less than a signature |

## Key custody and rotation

- **Who can sign:** only the release role, only from `main`, only in the release environment.
- **Who can verify:** anyone who can read the public key (`kms:GetPublicKey`). Operators get it; it is not secret.
- **Rotation:** manual (US1 edge cases). A new key, a new alias, re-sign the kept images, then drop the old key from the verify list. Annually, or at once on suspicion.
- **Deletion:** the profile's window (7 days synthetic, 30 production). Deleting the key makes every image unverifiable, so stage C fails closed.

**Residual risks (stated, not solved):**

- A compromised **merge to `main`** still produces a signed image. The signature proves "built by CI from `main`", not "safe". The required checks and the no-bypass ruleset (#197) are what guard `main`.
- A compromised **GitHub Actions runner or action** during the release job could sign another digest. The pinned actions and the digest comparison narrow this, but do not remove it.
- An operator with **KMS admin** can change the key policy and let another principal sign. The audit trail's `EncryptionKeyChanged` alarm already fires on `PutKeyPolicy`, `DisableKey` and `ScheduleKeyDeletion` for **every** KMS key in the account (`audit.tf:100-103`), the signing key included. It alarms; it does not prevent.
