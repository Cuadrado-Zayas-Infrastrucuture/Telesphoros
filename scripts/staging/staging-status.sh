#!/usr/bin/env bash
# What synthetic staging runs, against docs/ops/staging-expected.json on origin/main (spec 027, PR 2). Founder-run, read-only.
# Run it before planning anything against staging, and quote its table. Exit 0 means there is nothing to do; anything else names what is stale.
#
#   scripts/staging/staging-status.sh
#
# Reads, and never writes, AWS: the ECS services and task definitions, the alarm count, the CloudFront cache paths, and the API's /api/v1/ready.
# Reads the Terraform state's serial and lineage (nothing else of it) and runs `plan -lock=false -detailed-exitcode` on the backend clone's
# HEAD, printing addresses and actions only. Lists the Terraform merged on origin/main after the applied commit, the saved plans and the claim.
# It does not fetch: run `git -C "$BACKEND_CLONE" fetch origin` first if origin/main may be behind.
#
# Live values come from a private file outside the repository, ~/telesphoros-private/staging/stack.env (override with STACK_ENV):
#   STAGING_ACCOUNT_ID   the staging account (12 digits)          BACKEND_CLONE   the founder's backend clone (on main)
#   TERRAFORM            the pinned Terraform 1.16.5 binary       TF_DATA_DIR     the backend's data directory
#   STAGING_VAR_FILE     the canonical var file (optional here; without it the plan row is "not run")
# Docs: docs/ops/environments.md, specs/027-staging-freshness/.
set -euo pipefail
umask 077

die() { echo "staging-status: $*" >&2; exit 2; }
HERE="$(cd "$(dirname "$0")" && pwd)"
PRIVATE="${PRIVATE_DIR:-$HOME/telesphoros-private}"
STACK_ENV="${STACK_ENV:-$PRIVATE/staging/stack.env}"
[ -f "$STACK_ENV" ] || die "no $STACK_ENV (see the header of this script)"
# shellcheck source=/dev/null
. "$STACK_ENV"
[[ "${STAGING_ACCOUNT_ID:-}" =~ ^[0-9]{12}$ ]] || die "STAGING_ACCOUNT_ID is not 12 digits"
[ -d "${BACKEND_CLONE:-}/.git" ] || [ -f "${BACKEND_CLONE:-}/.git" ] || die "BACKEND_CLONE is not a git checkout"
[ -x "${TERRAFORM:-}" ] || die "TERRAFORM is not an executable"
[ -d "${TF_DATA_DIR:-}" ] || die "TF_DATA_DIR is not a directory"
export TF_DATA_DIR AWS_REGION="${AWS_REGION:-us-east-2}" AWS_PROFILE="${AWS_PROFILE:-telesphoros}"
"$TERRAFORM" version | head -1 | grep -qx 'Terraform v1.16.5' || die "TERRAFORM is not 1.16.5"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/staging-status.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
MJS="$HERE/staging-status.mjs"
C="$BACKEND_CLONE"
TFDIR="$C/infrastructure/terraform"

echo "staging-status started $(date -u +%Y-%m-%dT%H:%M:%SZ)"
[ "$(aws sts get-caller-identity --query Account --output text </dev/null)" = "$STAGING_ACCOUNT_ID" ] || die "wrong account or expired login (run: aws login --profile $AWS_PROFILE)"
MAIN=$(git -C "$C" rev-parse origin/main) || die "the backend clone has no origin/main"
echo "facts: origin/main ${MAIN:0:8} ($(git -C "$C" log -1 --format=%cd --date=iso-strict origin/main)); clone HEAD $(git -C "$C" rev-parse --short=8 HEAD)"
git -C "$C" show origin/main:docs/ops/staging-expected.json > "$WORK/facts.json" || die "origin/main has no docs/ops/staging-expected.json"
fact() { node -e 'const f=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(process.argv[2].split(".").reduce((o,k)=>o?.[k],f)??"")' "$WORK/facts.json" "$1"; }

# A read AWS refuses is recorded by its error code alone, so the row is "unknown" and the run fails; it is never mistaken for an empty answer.
refused() { grep -oE '\(([A-Za-z]+)\)' "$WORK/err" | head -1 | tr -d '()' || true; }
read_aws() { # name, then the aws arguments; writes $WORK/<name>.out, or $WORK/<name>.refused
  local name=$1; shift
  if aws "$@" --output text </dev/null > "$WORK/$name.out" 2> "$WORK/err"; then return 0; fi
  refused > "$WORK/$name.refused"; return 1
}

CLUSTER=telesphoros-staging-api
for svc in api worker; do
  if read_aws "$svc-td" ecs describe-services --cluster "$CLUSTER" --services "telesphoros-staging-$svc" --query 'services[0].taskDefinition' \
    && [[ "$(cat "$WORK/$svc-td.out")" =~ :([0-9]+)$ ]]; then
    echo "${BASH_REMATCH[1]}" > "$WORK/$svc-revision"
    read_aws "$svc-image" ecs describe-task-definition --task-definition "$(cat "$WORK/$svc-td.out")" --query 'taskDefinition.containerDefinitions[0].image' \
      && sed -E 's/^.*@//' "$WORK/$svc-image.out" > "$WORK/$svc-digest" || true
  fi
done
read_aws alarms cloudwatch describe-alarms --alarm-name-prefix telesphoros-staging --query 'length(MetricAlarms)' || true
if read_aws dists cloudfront list-distributions --query 'DistributionList.Items[].Id' && [ "$(wc -w < "$WORK/dists.out" | tr -d ' ')" = 1 ]; then
  read_aws paths cloudfront get-distribution --id "$(tr -d '[:space:]' < "$WORK/dists.out")" \
    --query 'Distribution.DistributionConfig.CacheBehaviors.Items[].PathPattern' || true
fi
READY=$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 https://api.staging.telesphoros.app/api/v1/ready </dev/null || true)

# The newest migration in the running image's commit; /api/v1/ready answers 200 only when that binary's migrations are applied.
IMAGE_COMMIT=$(fact image.commit)
if [ "$(cat "$WORK/api-digest" 2>/dev/null)" = "$(fact image.digest)" ] && git -C "$C" cat-file -e "$IMAGE_COMMIT^{commit}" 2>/dev/null; then
  git -C "$C" ls-tree --name-only "$IMAGE_COMMIT" apps/backend/migrations/ | grep -oE '/[0-9]{4}_' | tr -d '/_' | sort | tail -1 > "$WORK/migration"
fi

echo "== state and plan"
"$TERRAFORM" -chdir="$TFDIR" state pull </dev/null 2>/dev/null | node "$MJS" project-state > "$WORK/state.json" 2>/dev/null || echo '{}' > "$WORK/state.json"
PLAN_EXIT=null; PLAN_WHY=""
if [ -z "${STAGING_VAR_FILE:-}" ] || [ ! -f "$STAGING_VAR_FILE" ]; then
  PLAN_WHY="no canonical var file (STAGING_VAR_FILE)"
elif pgrep -f 'terraform.*(apply|plan|import|untaint)' >/dev/null; then
  PLAN_WHY="another terraform process is running"
else
  set +e
  "$TERRAFORM" -chdir="$TFDIR" plan -input=false -no-color -lock=false -detailed-exitcode -var-file="$STAGING_VAR_FILE" -out="$WORK/status.tfplan" </dev/null > "$WORK/plan.log" 2>&1
  PLAN_EXIT=$?
  set -e
  if [ "$PLAN_EXIT" = 2 ]; then "$TERRAFORM" -chdir="$TFDIR" show -json "$WORK/status.tfplan" </dev/null | node "$MJS" project-plan > "$WORK/changes" || PLAN_EXIT=1; fi
  [ "$PLAN_EXIT" = 1 ] && PLAN_WHY="see the plan's own error: run the same plan by hand"
fi

APPLIED=$(fact appliedCommit)
if git -C "$C" merge-base --is-ancestor "$APPLIED" origin/main 2>/dev/null; then
  git -C "$C" log --first-parent --format='%h %s' "$APPLIED..origin/main" -- infrastructure/terraform > "$WORK/unapplied"
else
  echo "?????? the applied commit is not on origin/main: the facts file is wrong" > "$WORK/unapplied"
fi

# Saved plans made by the release recipe carry <plan>.meta.json with the state serial they were made from; older ones are only counted.
: > "$WORK/saved"
if [ -d "$PRIVATE/releases" ]; then find "$PRIVATE/releases" -name '*.tfplan' -type f | sort > "$WORK/saved"; fi
LEGACY=$(find "$PRIVATE" -maxdepth 2 -name '*.tfplan' -type f -not -path "$PRIVATE/releases/*" | wc -l | tr -d ' ')
CLAIM="$PRIVATE/staging/claim/owner.json"

READY="$READY" PLAN_EXIT="$PLAN_EXIT" PLAN_WHY="$PLAN_WHY" LEGACY="$LEGACY" CLAIM="$CLAIM" PRIVATE="$PRIVATE" \
  node "$MJS" collect "$WORK" > "$WORK/observed.json" || die "could not assemble what was read"
set +e
node "$MJS" report "$WORK/facts.json" "$WORK/observed.json"
STATUS=$?
set -e
exit "$STATUS"
