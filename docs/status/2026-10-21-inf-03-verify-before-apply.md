# INF-03 slice 3: verify the image signature before apply

Date: 2026-10-21

Third and last code slice of `specs/002-signed-image-release` (T014–T018):

- **`scripts/staging/verify-image.mjs` (new).** Before plan C, a person runs it on `api_image`, and on `api_migrate_image` when that is set. It
  resolves the stack's key `alias/<name_prefix>-<environment>-image-signing` to its ARN through KMS, checks that the key is an enabled ECC P-256 signing
  key, and runs `cosign verify --key awskms:///<key ARN> --insecure-ignore-tlog` on each digest. It requires every signed payload to name that
  digest. Only then does it write `verified-image.json` next to the saved plans.
- **`check-plan.mjs` stage C** now refuses a plan unless that record covers its images and was made with this stack's key alias, by a key in the
  stack's account and Region, with cosign 3.
- **Break-glass (decision D3).** `--unsigned-break-glass "<reason>"` records an unsigned digest for synthetic staging, and both scripts print the
  reason. Both refuse it for production. Each use is listed in `docs/ops/ci-cd.md`.
- **`docs/ops/image-push.md` rewritten:**
  - CI pushes and signs;
  - the manual push is break-glass only;
  - the one CI credential exception is stated exactly: the release role, one hour, its actions;
  - how to export the public key.
- **SC-004 seen:** on the merge of #222, `release-image` was skipped on `main` and all 11 jobs were green.

Nothing is applied in AWS. The record is a local file: it catches a skipped or wrong verification, not a person who can apply Terraform.

Verification: `docs/verification/signed-image-release.md`, slice 3.
