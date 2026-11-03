# Staging-only door to the image release role (INF-03 D6)

Date: 2026-11-03

The synthetic staging account cannot hold a GitHub OIDC provider: its AWS-managed project service control policy denies `iam:*Provider*`, and the published Paid Plan version denies it too. So the CI `release-image` job cannot run there, and every staging image so far was unsigned break-glass, which FENCE-OPEN refuses.

The founder chose a staging-only door (spec 002 decision D6). `signing.tf` gains `image_release_human_principals`: roles of the stack's account that may assume the release role, with an optional MFA condition. With that list alone the release role, the signing key and its alias are created and no OIDC provider is. The key policy is unchanged, so the release role remains the only signer. The role refuses the list in production and refuses roles of another account; `registry.tf` now requires production's release path to come from the GitHub IDs with no named roles. `docs/ops/image-push.md` gives the procedure: a manual CI run's archive, its digest checked against the `image` job, then CI's own `release-image.sh` under the release role.

Verification: `terraform validate`; `terraform test` 70 passed, 0 failed, including four new runs (named roles without GitHub, the MFA condition, refused in production, refused from another account). The signing guard passes, and each of its 30 broken copies of the text (9 of them new) is reported. No AWS call, apply or release was made. Synthetic data only.
