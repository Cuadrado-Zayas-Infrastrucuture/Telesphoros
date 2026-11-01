#!/usr/bin/env bash
# Apply one reviewed plan of a release (spec 027, PR 3a). Founder-run, under the claim.
#   CLAIM_OWNER=NAME scripts/staging/release/apply.sh MIGRATE|IMAGE|INFRA COMMIT PLAN_SHA256
# PLAN_SHA256 is the hash plan.sh printed, typed after reading the plan text: a different plan is refused. So is a plan whose record no longer
# matches the stack (another apply moved the state serial, the clone moved, the var file changed), before Terraform's own stale-plan refusal.
# Terraform runs detached (it survives a closing window) through apply-run.sh; its log ends "== apply exit status: N". After an IMAGE apply
# exits 0, release.tfvars becomes current.tfvars, so the next release cannot start from an older file.
set -euo pipefail
umask 077
# shellcheck source=scripts/staging/release/lib.sh
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"
MODE="${1:-}"; COMMIT="${2:-}"; PIN="${3:-}"
case "$MODE" in MIGRATE) T=m ;; IMAGE) T=i ;; INFRA) T=x ;; *) die "usage: apply.sh MIGRATE|IMAGE|INFRA COMMIT PLAN_SHA256" ;; esac
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || die "COMMIT must be a full 40-character commit id"
[[ "$PIN" =~ ^[0-9a-f]{64}$ ]] || die "PLAN_SHA256 must be the 64-character hash plan.sh printed"
load_stack
OUT="$PRIVATE/releases/$COMMIT"
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
case "$MODE" in INFRA) NEW=$OLD; VARFILE="$CURRENT" ;; MIGRATE) NEW=$(cat "$OUT/new_image.txt"); VARFILE="$CURRENT" ;; IMAGE) NEW=$(cat "$OUT/new_image.txt"); VARFILE="$OUT/release.tfvars" ;; esac
if [ "$MODE" = IMAGE ]; then
  grep -qx 'pending: (none)' "$OUT/migrate-status.txt" 2>/dev/null || die "IMAGE needs migrate-status.txt saying 'pending: (none)': migrate first"
fi
state_identity | node "$HERE/plan-record.mjs" check "$PLAN.meta.json" "$MODE" "$COMMIT" "$(sha "$VARFILE")" "$PIN" \
  || die "the plan is stale (above): plan again rather than applying it"
"$TERRAFORM" -chdir="$TFDIR" show -json "$PLAN" </dev/null > "$OUT/$T-apply-check.plan.json"
node "$HERE/release-check.mjs" "$MODE" "$OUT/$T-apply-check.plan.json" "$OLD" "$NEW" || die "release check refused the $MODE plan"
rm -f "$OUT/$T-apply-check.plan.json"
echo ok

echo "== 2. Apply, detached. Log: $LOG"
nohup bash "$HERE/apply-run.sh" "$MODE" "$PLAN" "$LOG" "$VARFILE" >/dev/null 2>&1 </dev/null &
echo "started (pid $!). It keeps running if this window closes; a service rollout waits for steady state, so allow 5 to 15 minutes."
echo "Tell Claude it started."
