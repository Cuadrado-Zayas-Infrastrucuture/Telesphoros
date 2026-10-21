# INF-03 slice 2: CI pushes the scanned image and signs it (draft PR)

Date: 2026-10-21

Second slice of `specs/002-signed-image-release`:

- **The headline finding:** CI was not scanning the image it keeps. Trivy, the readiness test and the rehearsal ran a second `--load` build, whose last three layers (`COPY /output/` onward) were rebuilt with different bytes. That's shown by a config diff on 2026-10-21.
- **`image` job:** it now builds once and outputs the archive's digest. It loads the archive's **own** linux/amd64 image (`load-archive-image.sh`), checked by config digest, and Trivy, the readiness test and the rehearsal run that image. On every run it also rehearses the release (`release-rehearsal.sh`): a local registry, a throwaway key, and every outbound proxy closed.
- **New `release-image` job:** it runs only on a push to `main` once the founder has set `IMAGE_RELEASE_ROLE_ARN`. It holds the repository's only write permission (`id-token`), is not a required check, and must fail visibly. It downloads the archive and checks its digest. It pushes the archive to ECR with `crane` **without `--index`** (which would change the digest) and confirms ECR kept the digest. It signs with the KMS key through `cosign --use-signing-config=false --tlog-upload=false`, then verifies.
- **Found by running the tools:**
  - cosign 3 needs both flags, or it uploads to the public Rekor log;
  - a pipefail and `grep -q` race in the fallback-tag check, now fixed and guarded;
  - the archive was already uploaded on every run.
- **Pins:** cosign v3.1.3 and crane v0.22.1, checked against their published checksums.
- **Dormant:** nothing runs against AWS until the founder applies `signing.tf`, creates the `image-release` environment and sets four repository variables (`docs/ops/ci-cd.md`).

Verification: `docs/verification/signed-image-release.md`.
