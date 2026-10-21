# Tasks: Only the image CI built and scanned can be deployed (INF-03)

**Input**: [spec.md](spec.md), [plan.md](plan.md)

**Prerequisites**: plan.md **approved by the founder on 2026-10-20** with the recommended D1–D5. `/speckit-implement` may run against this file, one phase per draft PR.

**Tests**: Required by the spec (SC-001 to SC-005). In each phase the test tasks come first, and they must fail before the implementation lands.

**Organization**: One phase per slice in plan.md, one draft PR per phase off `main`, never stacked. `[P]` marks tasks that can run in parallel within a phase (different files, no dependency).

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Slice 1, Terraform: signing key, OIDC trust, release role (US1, US4) — needs D2, D5

### Tests first

- [ ] T001 [P] [US1] `signing.guard.test.mjs`. It requires:
  - the key: `key_spec = "ECC_NIST_P256"`, `key_usage = "SIGN_VERIFY"`, no rotation flag, the profile's deletion window, and a policy that grants `kms:Sign` to the release role only and no encrypt or decrypt action;
  - the role's trust conditions of FR-002, every one present, `StringEquals` (no wildcard on `ref`, the environment or `job_workflow_ref`);
  - the role's permissions of FR-003, resource-scoped.

  Each rule has a broken copy. Run it against `main`: red.
- [ ] T002 [P] [US4] `profiles.tftest.hcl` runs:
  - API hosting off: no key, no role.
  - API hosting on: one key, one role.
  - The OIDC provider variable set: reused, not created.
  - Production and synthetic plan.
- [ ] T003 [P] The rotation exception: `api-compute`/`audit`/`worker`/`logs` guards stay as they are. The signing guard asserts the key has **no** `enable_key_rotation = true` (KMS refuses it for asymmetric keys) and that this is the only such key.

### Implementation

- [ ] T004 [US1] `infrastructure/terraform/signing.tf`: key and alias, the OIDC provider (`count` from the reuse variable), the role, its policy; outputs: role ARN, key alias, public-key fetch command
- [ ] T005 [US4] Gate everything on `local.api_count`, the same switch as the registry. Variables: `github_repository_id`, `github_repository_owner_id`, `github_oidc_provider_arn` (empty means create), `image_release_environment`.
- [ ] T006 [D5] `registry.tf`: the lifecycle rule keeps an image's signature with it. Record in `docs/verification/signed-image-release.md` how ECR counts referrers. If that cannot be shown offline, record it as a first-apply check and choose the conservative rule.
- [ ] T007 `pnpm test:infra`, `terraform fmt`/`validate`/`test` on both roots, tflint; defect injection on each new rule; `docs/verification/signed-image-release.md` started.

**Checkpoint**: the founder reviews the trust policy before any CI change.

## Phase 2: Slice 2, CI pushes the scanned archive and signs it (US2, US3, US4) — needs D1; starts after #207 merges

### Tests first

- [ ] T008 [P] [US3] `.github/ci/release.test.mjs`:
  - `id-token: write` appears exactly once, on `release-image`;
  - its `if` requires push, `refs/heads/main` and the role variable;
  - `needs: image`; `environment` is the release environment;
  - `--tlog-upload=false` is on the sign command;
  - no `secrets.`; every action is SHA-pinned; cosign and the copy tool are pinned by version and checksum;
  - the digest comparison step exists and precedes signing.

  Each rule has a broken copy.
- [ ] T009 [P] [US2] A local proof script (`infrastructure/docker/release-rehearsal.cjs` or a `node:test`). It builds the archive as CI does, pushes it to a digest-pinned local `registry:2` with the chosen copy tool, and asserts the digest is unchanged. Control: rebuild instead; the digests differ, and the comparison refuses.
- [ ] T010 [P] [US3] Transparency-log control: with a **file** key and the transparency-log URL set to a closed local port, signing with `--tlog-upload=false` succeeds. The same command without the flag fails.

### Implementation

- [ ] T011 [US2] `image` job: compute the index digest from `index.json` and expose it as an output; on push to `main`, upload `api.oci.tar` (one day).
- [ ] T012 [US2, US3, US4] `release-image` job per plan.md "The release job"; the job summary names the digest and tag.
- [ ] T013 `pnpm test:ci-config`, actionlint, the full local loop; after merge, confirm on GitHub that `release-image` is skipped on `main` and every required check is green (SC-004).

## Phase 3: Slice 3, verify before apply (US1, US5) — needs D3

### Tests first

- [ ] T014 [P] [US1] `verify-image.test.mjs` with a stub `cosign` on `PATH` (the pattern `scripts/staging/run-task.test.mjs` uses for its stubbed `aws`). Cases:
  - signed: record written;
  - unsigned: refused;
  - other key: refused;
  - a tag instead of a digest: refused;
  - a cosign error: refused, never "verified".
- [ ] T015 [P] [US1] `check-plan.test.mjs`: stage C with no record, a record for another digest, a stale record format, or `api_migrate_image` unverified, is refused; a matching record is accepted (SC-001).
- [ ] T016 [P] [US5] Break-glass: refused for production; for synthetic, recorded with its reason and printed.

### Implementation

- [ ] T017 [US1] `scripts/staging/verify-image.mjs`; `check-plan.mjs` stage C reads `verified-image.json`.
- [ ] T018 Rewrite `docs/ops/image-push.md`: CI pushes and signs; manual push is break-glass; the exact credential exception; how to fetch the public key. Update `docs/ops/ci-cd.md` (the `release-image` job, the one `id-token` exception), `docs/STATUS.md`, and `docs/verification/signed-image-release.md`.

## Phase 4: Founder, first apply (after the BAA and approval of the apply)

- [ ] T019 Create the release environment (D1), and set `repository_id` and `repository_owner_id` in the tfvars.
- [ ] T020 Apply slice 1's Terraform; set the role variable; push to `main` once; run `verify-image.mjs` on the result.
- [ ] T021 Confirm and record:
  - A1: `job_workflow_ref` in the `AssumeRoleWithWebIdentity` CloudTrail event;
  - A2: the KMS signer works with ECC P-256;
  - A3: referrers and the lifecycle rule;
  - that Fargate pulls the index with attestation manifests.

## Dependencies & Execution Order

- Phase 1 → Phase 2 → Phase 3, each merged before the next starts.
- Phase 2 also waits for #207 (supply-chain pins).
- Phase 4 waits for the BAA and an approved apply.
- Within a phase, the `[P]` test tasks run in parallel, and all tests precede implementation.
