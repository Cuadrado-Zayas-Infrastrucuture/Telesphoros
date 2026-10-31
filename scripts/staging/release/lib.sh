# shellcheck shell=bash
# Shared by the release scripts in this folder (spec 027, PR 3a). Sourced, never run. Founder-run, synthetic staging only.
# Live values come from the private ~/telesphoros-private/staging/stack.env (override with STACK_ENV), never from this repository:
#   STAGING_ACCOUNT_ID   12 digits                       BACKEND_CLONE   the founder's backend clone (on main)
#   TERRAFORM            the pinned 1.16.5 binary         TF_DATA_DIR     the backend's data directory
#   STAGING_ROLE_ARN_PART  optional; the caller's ARN must contain it (for example the role name)
# The canonical var file is $PRIVATE/staging/current.tfvars, with its sha256 beside it; it is the only var file a release reads.
# Each release writes its outputs to $PRIVATE/releases/<commit>/, never copies of these scripts.

die() { printf 'STOP: %s\n' "$*" >&2; exit 1; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PRIVATE="${PRIVATE_DIR:-$HOME/telesphoros-private}"
STAGING="$PRIVATE/staging"
CURRENT="$STAGING/current.tfvars"
CLAIM_DIR="$STAGING/claim"

load_stack() {
  local env="${STACK_ENV:-$STAGING/stack.env}"
  [ -f "$env" ] || die "no $env (see scripts/staging/release/lib.sh)"
  # shellcheck source=/dev/null
  . "$env"
  [[ "${STAGING_ACCOUNT_ID:-}" =~ ^[0-9]{12}$ ]] || die "STAGING_ACCOUNT_ID is not 12 digits"
  [ -e "${BACKEND_CLONE:-}/.git" ] || die "BACKEND_CLONE is not a git checkout"
  [ -x "${TERRAFORM:-}" ] || die "TERRAFORM is not an executable"
  [ -d "${TF_DATA_DIR:-}" ] || die "TF_DATA_DIR is not a directory"
  export TF_DATA_DIR AWS_REGION="${AWS_REGION:-us-east-2}" AWS_PROFILE="${AWS_PROFILE:-telesphoros}"
  C="$BACKEND_CLONE"
  TFDIR="$C/infrastructure/terraform"
  "$TERRAFORM" version | head -1 | grep -qx 'Terraform v1.16.5' || die "TERRAFORM is not 1.16.5"
}

sha() { shasum -a 256 "$1" | cut -c1-64; }

gate_identity() {
  [ "$(aws sts get-caller-identity --query Account --output text </dev/null)" = "$STAGING_ACCOUNT_ID" ] || die "wrong account or expired login (run: aws login --profile $AWS_PROFILE)"
  if [ -n "${STAGING_ROLE_ARN_PART:-}" ]; then
    aws sts get-caller-identity --query Arn --output text </dev/null | grep -qF "$STAGING_ROLE_ARN_PART" || die "not the expected role session"
  fi
}

gate_quiet() { if pgrep -f 'terraform.*(apply|plan|import|untaint)' >/dev/null 2>&1; then die "a terraform process is running"; fi; }

gate_clone() { # the commit this release plans from
  [ "$(git -C "$C" rev-parse --abbrev-ref HEAD)" = main ] || die "the clone is not on main"
  [ -z "$(git -C "$C" status --porcelain --untracked-files=no)" ] || die "tracked changes in the clone"
  [ "$(git -C "$C" rev-parse HEAD)" = "$1" ] || die "the clone is at $(git -C "$C" rev-parse --short=8 HEAD), not ${1:0:8}: run git -C \"$C\" merge --ff-only $1 first"
}

# The claim: one owner at a time plans or applies against the stack. Taken with mkdir, which is atomic; never broken by a script.
claim_check() {
  [ -n "${CLAIM_OWNER:-}" ] || die "set CLAIM_OWNER to the name you took the claim with (claim.sh take NAME REASON)"
  [ -f "$CLAIM_DIR/owner.json" ] || die "no claim is held: run claim.sh take $CLAIM_OWNER <reason> first"
  node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(c.owner===process.argv[2]?0:1)' "$CLAIM_DIR/owner.json" "$CLAIM_OWNER" \
    || die "the claim is held by someone else: $(node -e 'const c=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(c.owner+" since "+c.started+" ("+c.reason+")")' "$CLAIM_DIR/owner.json")"
}

# The image that runs now: what the canonical var file names twice, and what ECS runs. Prints it.
running_image() {
  [ -f "$CURRENT" ] && [ -f "$CURRENT.sha256" ] || die "no $CURRENT with its .sha256 (spec 027 T010)"
  [ "$(sha "$CURRENT")" = "$(cat "$CURRENT.sha256")" ] || die "current.tfvars does not match its recorded sha256: it was edited by hand"
  local api mig ecs
  api=$(sed -nE 's/^api_image[[:space:]]*=[[:space:]]*"([^"]+)".*$/\1/p' "$CURRENT")
  mig=$(sed -nE 's/^api_migrate_image[[:space:]]*=[[:space:]]*"([^"]+)".*$/\1/p' "$CURRENT")
  [ -n "$api" ] && [ "$api" = "$mig" ] || die "current.tfvars does not name one image as both api_image and api_migrate_image"
  ecs=$(aws ecs describe-task-definition --task-definition "$(aws ecs describe-services --cluster telesphoros-staging-api --services telesphoros-staging-api \
    --query 'services[0].taskDefinition' --output text </dev/null)" --query 'taskDefinition.containerDefinitions[0].image' --output text </dev/null) || die "cannot read the running api image"
  [ "$ecs" = "$api" ] || die "ECS runs ${ecs##*@}, but current.tfvars names ${api##*@}: the var file is stale; tell Claude"
  printf '%s\n' "$api"
}

state_identity() { "$TERRAFORM" -chdir="$TFDIR" state pull </dev/null 2>/dev/null | node "$HERE/plan-record.mjs" state; }
