#!/usr/bin/env bash
# The image step of a release onto running synthetic staging (spec 027, PR 3b), BREAK-GLASS: an unsigned image, synthetic staging only
# (docs/ops/image-push.md "Break-glass"). Founder-run, under the claim. Pushes an image; applies nothing in Terraform.
#   CLAIM_OWNER=NAME scripts/staging/release/image.sh BUILD COMMIT
# First write why the image is unsigned, one line of 10 to 300 characters, to ~/telesphoros-private/releases/COMMIT/break-glass-reason.txt.
# Needs CI's image job green on COMMIT, or, when the push run skipped it by tree reuse (.github/ci/scope.mjs), on the pull-request head with
# exactly COMMIT's tree. Builds linux/amd64 from a fresh detached worktree beside the clone (<clone>-release-<commit8>), runs CI's synthetic
# rehearsal, pushes manual-<sha12>, reads the digest from ECR, waits for ECR's scan of the linux/amd64 manifest inside the index (ECR does not
# scan the index), records the exception with verify-image.mjs, and writes new_image.txt last. Outputs go to releases/COMMIT/.
set -euo pipefail
umask 077
# shellcheck source=scripts/staging/release/lib.sh
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"
[ "${1:-}" = BUILD ] || die "usage: image.sh BUILD COMMIT (BUILD confirms that this pushes an image)"
COMMIT="${2:-}"
release_folder "$COMMIT"
load_stack
W="$C-release-${COMMIT:0:8}"
mkdir -p "$OUT"
[ ! -e "$OUT/new_image.txt" ] || die "$OUT/new_image.txt exists: the image step already finished; tell Claude"
[ -f "$OUT/break-glass-reason.txt" ] || die "no $OUT/break-glass-reason.txt: write why this image is unsigned, one line"
REASON="$(cat "$OUT/break-glass-reason.txt")"
# argv[1] is a placeholder: verify-image.mjs runs as a command when argv[1] is its own path.
node -e 'import(process.argv[2]).then((m) => process.exit(m.validReason(process.argv[3]) ? 0 : 1));' \
  reason "$HERE/../verify-image.mjs" "$REASON" || die "break-glass-reason.txt must be one line of 10 to 300 characters"
step_lock image
exec > >(tee -a "$OUT/image.log") 2>&1
echo "release image ${COMMIT:0:8} started $(date -u +%H:%M:%SZ)"

echo "== 1. Gates"
claim_check
gate_node
gate_identity
gate_clone "$COMMIT"
git -C "$C" merge-base --is-ancestor "$COMMIT" origin/main || die "${COMMIT:0:8} is not on origin/main (fetch the clone first)"
REPO=$(git -C "$C" remote get-url origin | sed -E 's#^(https://github\.com/|git@github\.com:)##; s#\.git$##')
[[ "$REPO" =~ ^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$ ]] || die "the clone's origin is not a GitHub repository"
docker info >/dev/null 2>&1 </dev/null || die "Docker is not running (start Docker Desktop)"
docker buildx version >/dev/null </dev/null || die "docker buildx missing"
echo "CI on ${COMMIT:0:8} (no api_image unless CI's image job was green on the same commit):"
RID=$(gh run list --repo "$REPO" --commit "$COMMIT" --workflow ci.yml --json databaseId,event --jq '[.[]|select(.event=="push")][0].databaseId' </dev/null) || die "gh run list failed"
[ -n "$RID" ] && [ "$RID" != null ] || die "no push run of ci.yml on ${COMMIT:0:8}"
IMG_JOB=$(gh run view "$RID" --repo "$REPO" --json jobs --jq '.jobs[]|select(.name=="image")|.conclusion' </dev/null) || die "gh run view failed"
echo "  push run $RID, image job: ${IMG_JOB:-none}"
# A skipped image job counts only with the same proof as before: a pull_request run on a head with exactly this commit's tree, whose image job succeeded.
if [ "$IMG_JOB" = skipped ]; then
  PRHEAD=$(git -C "$C" rev-parse --verify --quiet "$COMMIT^2") || die "${COMMIT:0:8} is not a merge commit: no pull-request head to reuse"
  [ "$(git -C "$C" rev-parse "$PRHEAD^{tree}")" = "$(git -C "$C" rev-parse "$COMMIT^{tree}")" ] || die "the merge tree differs from the pull-request head tree: no reuse"
  PRRUN=$(gh run list --repo "$REPO" --commit "$PRHEAD" --workflow ci.yml --json databaseId,event --jq '[.[]|select(.event=="pull_request")][0].databaseId' </dev/null) || die "gh run list failed"
  [ -n "$PRRUN" ] && [ "$PRRUN" != null ] || die "no pull_request run on the pull-request head ${PRHEAD:0:8}"
  IMG_JOB=$(gh run view "$PRRUN" --repo "$REPO" --json jobs --jq '.jobs[]|select(.name=="image")|"\(.status) \(.conclusion)"' </dev/null) || die "gh run view failed"
  echo "  tree reuse: pull-request head ${PRHEAD:0:8} (same tree), run $PRRUN, image job: ${IMG_JOB:-none}"
  [ "$IMG_JOB" = "completed success" ] && IMG_JOB=success
fi
[ "$IMG_JOB" = success ] || die "CI's image job on ${COMMIT:0:8} is '${IMG_JOB:-missing}', not success"
# The build worktree is checked out under umask 022: `COPY . .` keeps host modes, and the image runs as user 10001.
unreadable() { find "$W" -path "$W/.git" -prune -o -path "$W/node_modules" -prune -o -type f ! -perm -o=r -print | sed -n 1p; }
if [ ! -e "$W" ]; then (umask 022 && git -C "$C" worktree add -q --detach "$W" "$COMMIT" </dev/null) || die "worktree add failed"; fi
[ "$(git -C "$W" rev-parse HEAD)" = "$COMMIT" ] || die "the build worktree $W is not at ${COMMIT:0:8}"
[ -z "$(git -C "$W" status --porcelain)" ] || die "the build worktree is not clean (untracked files count too)"
[ -z "$(unreadable)" ] || die "a file in the build worktree is not world-readable: $(unreadable)"
REPO_URL=$(tf_out api_repository_url) || die "cannot read api_repository_url"
REPO_NAME=${REPO_URL#*/}
TAG=manual-$(git -C "$W" rev-parse --short=12 HEAD)
OLD=$(running_image)
echo "repository ${REPO_NAME}, tag ${TAG}; running image ${OLD##*@}"
echo ok

echo "== 2. Build (linux/amd64) and rehearse, unless the tag is already in ECR (tags are immutable)"
cd "$W"
EXISTING=$(aws ecr describe-images --repository-name "$REPO_NAME" --image-ids imageTag="$TAG" --query 'imageDetails[0].imageDigest' --output text </dev/null 2>/dev/null || true)
if [ -n "$EXISTING" ] && [ "$EXISTING" != None ]; then
  echo "tag already in ECR: reusing it, no rebuild"
else
  aws ecr get-login-password </dev/null | docker login --username AWS --password-stdin "${REPO_URL%%/*}" || die "ECR login failed"
  docker buildx build --platform linux/amd64 --load -f infrastructure/docker/api.Dockerfile -t "$REPO_URL:$TAG" . </dev/null || die "build failed"
  node infrastructure/docker/rehearsal.cjs "$REPO_URL:$TAG" </dev/null || die "synthetic rehearsal failed: not pushing"
  docker push "$REPO_URL:$TAG" </dev/null || die "push failed"
fi

echo "== 3. Digest from ECR (not from build output) and ECR's scan of the linux/amd64 manifest"
DIGEST=$(aws ecr describe-images --repository-name "$REPO_NAME" --image-ids imageTag="$TAG" --query 'imageDetails[0].imageDigest' --output text </dev/null)
[[ "$DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]] || die "no digest in ECR"
IMAGE="$REPO_URL@$DIGEST"
[ "$IMAGE" != "$OLD" ] || die "the new digest equals the running one: nothing to release"
echo "image: $IMAGE"
MTYPE=$(aws ecr describe-images --repository-name "$REPO_NAME" --image-ids imageDigest="$DIGEST" --query 'imageDetails[0].imageManifestMediaType' --output text </dev/null)
case "$MTYPE" in
  application/vnd.oci.image.index.v1+json|application/vnd.docker.distribution.manifest.list.v2+json)
    MANIFEST=$(aws ecr batch-get-image --repository-name "$REPO_NAME" --image-ids imageDigest="$DIGEST" --accepted-media-types "$MTYPE" \
      --query 'images[0].imageManifest' --output text </dev/null) || die "cannot read the image index"
    AMD=$(printf '%s' "$MANIFEST" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=JSON.parse(s);const x=(m.manifests||[]).filter(e=>e.platform&&e.platform.os==="linux"&&e.platform.architecture==="amd64");if(x.length!==1)process.exit(3);process.stdout.write(x[0].digest)})') \
      || die "expected exactly one linux/amd64 manifest in the index" ;;
  *) AMD=$DIGEST ;;
esac
echo "index ${DIGEST:0:19}…  linux/amd64 manifest ${AMD:0:19}…  ($MTYPE)"
ST=PENDING
for _ in $(seq 1 "${SCAN_POLLS:-30}"); do
  ST=$(aws ecr describe-image-scan-findings --repository-name "$REPO_NAME" --image-id imageDigest="$AMD" --query 'imageScanStatus.status' --output text </dev/null 2>/dev/null || echo PENDING)
  { [ "$ST" = COMPLETE ] || [ "$ST" = FAILED ] || [ "$ST" = UNSUPPORTED_IMAGE ]; } && break
  sleep "${SCAN_WAIT:-10}"
done
echo "scan status: $ST"
[ "$ST" = COMPLETE ] || die "ECR's amd64 scan is $ST, not COMPLETE: rerun later (the tag is reused), or tell Claude"
{
  echo "release ${COMMIT:0:8}, linux/amd64 manifest $AMD, scanned $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  aws ecr describe-image-scan-findings --repository-name "$REPO_NAME" --image-id imageDigest="$AMD" --query 'imageScanFindings.findingSeverityCounts' --output json </dev/null
  echo "HIGH and CRITICAL findings (severity, package, CVE):"
  # shellcheck disable=SC2016 # the backticks are JMESPath literals for --query, not shell expansions
  aws ecr describe-image-scan-findings --repository-name "$REPO_NAME" --image-id imageDigest="$AMD" \
    --query 'imageScanFindings.findings[?severity==`HIGH` || severity==`CRITICAL`].[severity, attributes[?key==`package_name`].value | [0], name]' --output text </dev/null | sort
} > "$OUT/scan.txt" || die "cannot read the scan findings"
cat "$OUT/scan.txt"

echo "== 4. Break-glass record (unsigned, synthetic staging only), then new_image.txt last"
node "$HERE/../verify-image.mjs" --name-prefix telesphoros --environment staging --record "$OUT/verified-image.json" \
  --unsigned-break-glass "$REASON" "$IMAGE" </dev/null || die "verify-image refused"
printf '%s\n' "$OLD" > "$OUT/old_image.txt"
printf '%s\n' "$IMAGE" > "$OUT/new_image.txt.tmp" && mv "$OUT/new_image.txt.tmp" "$OUT/new_image.txt"
echo "new image: $IMAGE"
echo "Done. Next: plan.sh MIGRATE $COMMIT"
