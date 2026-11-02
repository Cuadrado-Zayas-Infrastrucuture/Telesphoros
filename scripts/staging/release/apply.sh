#!/usr/bin/env bash
# Apply one reviewed plan of a release (spec 027, PR 3a). Founder-run, under the claim.
#   CLAIM_OWNER=NAME scripts/staging/release/apply.sh MIGRATE|IMAGE|INFRA COMMIT PLAN_SHA256
#   CLAIM_OWNER=NAME scripts/staging/release/apply.sh FENCE-CLOSE|FENCE-OPEN COMMIT PLAN_SHA256 OPERATION_ID
# PLAN_SHA256 is the hash plan.sh printed, typed after reading the plan text: a different plan is refused. So is a plan whose record no longer
# matches the stack (another apply moved the state serial, the clone moved, the var file changed), before Terraform's own stale-plan refusal.
# Terraform runs detached (it survives a closing window) through apply-run.sh; its log ends "== apply exit status: N". After an IMAGE apply
# exits 0, release.tfvars becomes current.tfvars, so the next release cannot start from an older file.
set -euo pipefail
umask 077
# shellcheck source=scripts/staging/release/lib.sh
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"
MODE="${1:-}"; COMMIT="${2:-}"; PIN="${3:-}"
case "$MODE" in MIGRATE) T=m ;; IMAGE) T=i ;; INFRA) T=x ;; FENCE-CLOSE) T=fc ;; FENCE-OPEN) T=fo ;; *) die "usage: apply.sh MIGRATE|IMAGE|INFRA|FENCE-CLOSE|FENCE-OPEN COMMIT PLAN_SHA256" ;; esac
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || die "COMMIT must be a full 40-character commit id"
[[ "$PIN" =~ ^[0-9a-f]{64}$ ]] || die "PLAN_SHA256 must be the 64-character hash plan.sh printed"
load_stack
RELEASE_OUT="$PRIVATE/releases/$COMMIT"
OUT="$RELEASE_OUT"
OPERATION=""
if [[ "$MODE" = FENCE-CLOSE || "$MODE" = FENCE-OPEN ]]; then
  [ "$#" = 4 ] || die "fence apply needs COMMIT, PLAN_SHA256 and OPERATION_ID"
  OPERATION="${4:-}"
  [[ "$OPERATION" =~ ^[a-z0-9][a-z0-9-]{0,47}$ ]] || die "fence operation id must be 1-48 lower-case letters, digits or hyphens"
  OUT="$OUT/fences/$OPERATION"
fi
PLAN="$OUT/$T.tfplan"
LOG="$OUT/$T-apply.txt"
echo "release apply $MODE ${COMMIT:0:8} started $(date -u +%H:%M:%SZ)"

echo "== 1. Gates"
claim_check
[ -f "$PLAN" ] || die "no $PLAN: run plan.sh first"
[ "$(sha "$PLAN")" = "$PIN" ] || die "the plan's sha256 is not the one given: this is not the plan that was read"
[ ! -e "$LOG" ] || die "$LOG exists: this apply was already started; tell Claude"
gate_quiet
gate_identity
gate_clone "$COMMIT"
OLD=$(running_image)
case "$MODE" in FENCE-CLOSE|FENCE-OPEN) NEW=$OLD; VARFILE="$OUT/$T.tfvars" ;; INFRA) NEW=$OLD; VARFILE="$CURRENT" ;; MIGRATE) NEW=$(cat "$OUT/new_image.txt"); VARFILE="$CURRENT" ;; IMAGE) NEW=$(cat "$OUT/new_image.txt"); VARFILE="$OUT/release.tfvars" ;; esac
if [ "$MODE" = FENCE-OPEN ]; then
  [ -f "$RELEASE_OUT/verified-image.json" ] && [ "$(cat "$RELEASE_OUT/new_image.txt" 2>/dev/null)" = "$OLD" ] || die "opening needs the running image's verified release at this commit"
  node "$HERE/fence-image-record.mjs" "$RELEASE_OUT/verified-image.json" "$OLD" || die "running image verification record refused"
  grep -qx '== apply exit status: 0' "$RELEASE_OUT/i-apply.txt" 2>/dev/null || die "opening needs the coordinated IMAGE apply to finish first"
  grep -qx 'pending: (none)' "$RELEASE_OUT/migrate-status.txt" 2>/dev/null || die "opening needs migrations confirmed complete"
fi
if [ "$MODE" = IMAGE ]; then
  grep -qx 'pending: (none)' "$OUT/migrate-status.txt" 2>/dev/null || die "IMAGE needs migrate-status.txt saying 'pending: (none)': migrate first"
fi
SOURCE_ARGS=()
if [[ "$MODE" = FENCE-CLOSE || "$MODE" = FENCE-OPEN ]]; then
  [ -f "$OUT/source.tfvars" ] && [ "$(sha "$OUT/source.tfvars")" = "$(sha "$CURRENT")" ] || die "fence source variables changed after planning"
  SOURCE_ARGS=("$(sha "$CURRENT")")
  node "$HERE/fence-vars.mjs" check "$CURRENT" "$VARFILE" "$MODE" || die "fence var file no longer matches its source"
fi
TARGET_VAR_PIN=$(sha "$VARFILE")
state_identity | node "$HERE/plan-record.mjs" check "$PLAN.meta.json" "$MODE" "$COMMIT" "$TARGET_VAR_PIN" "$PIN" ${SOURCE_ARGS[@]+"${SOURCE_ARGS[@]}"} \
  || die "the plan is stale (above): plan again rather than applying it"
CHECK_PLAN="$OUT/$T-apply-check.plan.json"
if [[ "$MODE" = FENCE-CLOSE || "$MODE" = FENCE-OPEN ]]; then CHECK_PLAN=$(mktemp "$OUT/$T-apply-check.XXXXXX"); fi
"$TERRAFORM" -chdir="$TFDIR" show -json "$PLAN" </dev/null > "$CHECK_PLAN"
node "$HERE/release-check.mjs" "$MODE" "$CHECK_PLAN" "$OLD" "$NEW" || die "release check refused the $MODE plan"
rm -f "$CHECK_PLAN"
if [[ "$MODE" = FENCE-CLOSE || "$MODE" = FENCE-OPEN ]]; then
  mkdir "$OUT/apply-started" 2>/dev/null || die "this fence operation's apply was already started"
fi
echo ok

echo "== 2. Apply, detached. Log: $LOG"
nohup bash "$HERE/apply-run.sh" "$MODE" "$PLAN" "$LOG" "$VARFILE" "$TARGET_VAR_PIN" "${SOURCE_ARGS[0]-}" "$PIN" >/dev/null 2>&1 </dev/null &
echo "started (pid $!). It keeps running if this window closes; a service rollout waits for steady state, so allow 5 to 15 minutes."
echo "Tell Claude it started."
