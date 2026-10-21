#!/usr/bin/env bash
# The `release-image` job's work (INF-03 slice 2, specs/002-signed-image-release). Pushes the archive the `image` job built, scanned and rehearsed to ECR
# WITHOUT a rebuild, checks that the registry kept its exact digest, and signs that digest with the KMS image-signing key, writing nothing to any public
# transparency log. release-rehearsal.sh runs these same commands against a local registry on every pull request.
#
# Environment (from the job): AWS credentials of the release role (OIDC), AWS_REGION, IMAGE_REPOSITORY_URL (Terraform output api_repository_url),
# IMAGE_SIGNING_KEY_ALIAS (output image_signing_key_alias, "alias/…"), IMAGE_DIGEST (the `image` job's output), GITHUB_SHA.
# Usage: release-image.sh <api.oci.tar>   (cosign, crane, aws on PATH)
set -euo pipefail

archive="${1:?usage: release-image.sh <archive>}"
: "${AWS_REGION:?}" "${IMAGE_REPOSITORY_URL:?}" "${IMAGE_SIGNING_KEY_ALIAS:?}" "${IMAGE_DIGEST:?}" "${GITHUB_SHA:?}"
[[ "$IMAGE_DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "IMAGE_DIGEST is not a digest" >&2; exit 1; }
[[ "$IMAGE_REPOSITORY_URL" =~ ^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com/[a-z0-9._/-]+$ ]] || { echo "IMAGE_REPOSITORY_URL is not an ECR repository" >&2; exit 1; }
[[ "$IMAGE_SIGNING_KEY_ALIAS" =~ ^alias/[A-Za-z0-9/_-]+$ ]] || { echo "IMAGE_SIGNING_KEY_ALIAS is not a KMS alias" >&2; exit 1; }

registry="${IMAGE_REPOSITORY_URL%%/*}"
repository="${IMAGE_REPOSITORY_URL#*/}"
tag="git-${GITHUB_SHA:0:12}"
key="awskms:///${IMAGE_SIGNING_KEY_ALIAS}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

aws ecr get-login-password --region "$AWS_REGION" | crane auth login "$registry" --username AWS --password-stdin

# The registry's own record of a tag's digest (what a task will pull), or nothing.
registry_digest() {
  aws ecr describe-images --region "$AWS_REGION" --repository-name "$repository" --image-ids "imageTag=$tag" --query 'imageDetails[0].imageDigest' --output text 2>/dev/null || true
}

# Tags are immutable. A rerun finds its own image already there and goes on to sign; a tag holding anything else stops the release.
existing="$(registry_digest)"
if [ -z "$existing" ] || [ "$existing" = "None" ]; then
  mkdir "$work/layout"
  tar -xf "$archive" -C "$work/layout"
  crane push "$work/layout" "$IMAGE_REPOSITORY_URL:$tag" 2>"$work/push.log" || { cat "$work/push.log" >&2; exit 1; }
  existing="$(registry_digest)"
fi
[ "$existing" = "$IMAGE_DIGEST" ] || { echo "ECR holds $existing under $tag, not the digest CI built and scanned ($IMAGE_DIGEST)" >&2; exit 1; }

cosign sign --key "$key" --use-signing-config=false --tlog-upload=false --yes "$IMAGE_REPOSITORY_URL@$IMAGE_DIGEST"

# ECR serves the OCI 1.1 referrers API, so the signature must be an untagged referrer. A fallback "sha256-<digest>" tag would count toward the lifecycle
# rule and could not be updated under immutable tags (spec assumption A3): stop and say so.
# (Listed first, then searched: under pipefail, `crane ls | grep -q` can lose a match when grep exits early and crane dies of SIGPIPE.)
tags="$(crane ls "$IMAGE_REPOSITORY_URL")"
if grep -qx "sha256-${IMAGE_DIGEST#sha256:}" <<<"$tags"; then
  echo "cosign stored the signature under a fallback tag instead of the referrers API (assumption A3 does not hold): review the lifecycle rule" >&2
  exit 1
fi

cosign verify --key "$key" --insecure-ignore-tlog "$IMAGE_REPOSITORY_URL@$IMAGE_DIGEST" >/dev/null

{
  echo "### Image released and signed"
  echo
  echo "| | |"
  echo "|---|---|"
  echo "| Image | \`$IMAGE_REPOSITORY_URL@$IMAGE_DIGEST\` |"
  echo "| Tag | \`$tag\` |"
  echo "| Signed with | \`$key\` (no transparency log) |"
} >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
echo "released and signed $IMAGE_REPOSITORY_URL@$IMAGE_DIGEST"
