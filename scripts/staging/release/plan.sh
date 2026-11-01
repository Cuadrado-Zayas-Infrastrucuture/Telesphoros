#!/usr/bin/env bash
# Plan one step of a release onto running synthetic staging (spec 027, PR 3a). Founder-run, under the claim. PLAN ONLY: never applies.
#   CLAIM_OWNER=NAME scripts/staging/release/plan.sh MIGRATE COMMIT   api_migrate_image = NEW (releases/COMMIT/new_image.txt), api_image stays
#   CLAIM_OWNER=NAME scripts/staging/release/plan.sh IMAGE COMMIT     both images NEW; writes releases/COMMIT/release.tfvars
#   CLAIM_OWNER=NAME scripts/staging/release/plan.sh INFRA COMMIT     the canonical var file unchanged: merged Terraform alone, before a release
# Reads only current.tfvars (and, for IMAGE, the file made from it); the clone must be at exactly COMMIT. Each plan is checked by release-check.mjs
# and recorded next to itself (state serial and lineage, clone HEAD, var file and plan sha256). Read the plan text, then apply.sh with its sha256.
set -euo pipefail
umask 077
# shellcheck source=scripts/staging/release/lib.sh
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"
MODE="${1:-}"; COMMIT="${2:-}"
case "$MODE" in MIGRATE) T=m ;; IMAGE) T=i ;; INFRA) T=x ;; *) die "usage: plan.sh MIGRATE|IMAGE|INFRA COMMIT" ;; esac
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || die "COMMIT must be a full 40-character commit id"
load_stack
OUT="$PRIVATE/releases/$COMMIT"
mkdir -p "$OUT"
PLAN="$OUT/$T.tfplan"
echo "release plan $MODE ${COMMIT:0:8} started $(date -u +%H:%M:%SZ)"

echo "== 1. Gates"
claim_check
[ ! -e "$PLAN" ] || die "$PLAN exists: a $MODE plan was already made for this release; tell Claude"
gate_quiet
gate_identity
gate_clone "$COMMIT"
OLD=$(running_image)
if [ "$MODE" = INFRA ]; then NEW=$OLD; else
  NEW=$(cat "$OUT/new_image.txt" 2>/dev/null) || die "no $OUT/new_image.txt: the image step did not finish"
  [ -f "$OUT/verified-image.json" ] || die "no verified-image.json next to the new image"
  [ "$NEW" != "$OLD" ] || die "the new image is the running one: nothing to release"
fi
if [ "$MODE" = IMAGE ]; then
  grep -qx '== apply exit status: 0' "$OUT/m-apply.txt" 2>/dev/null || die "the MIGRATE apply of this release did not finish with exit 0"
fi
echo "ok: running ${OLD##*@}$([ "$MODE" = INFRA ] || echo ", new ${NEW##*@}")"

echo "== 2. Var file"
case "$MODE" in
  MIGRATE|INFRA) VARFILE="$CURRENT"; EXTRA=(); [ "$MODE" = MIGRATE ] && EXTRA=(-var "api_migrate_image=$NEW") ;;
  IMAGE)
    VARFILE="$OUT/release.tfvars"; EXTRA=()
    sed -E -e "s|^api_image[[:space:]]*=.*$|api_image = \"$NEW\"|" -e "s|^api_migrate_image[[:space:]]*=.*$|api_migrate_image = \"$NEW\"|" "$CURRENT" > "$VARFILE"
    [ "$(diff "$CURRENT" "$VARFILE" | grep -c '^[<>]')" = 4 ] || die "release.tfvars differs from current.tfvars by more than the two image lines"
    ;;
esac
VARSHA=$(sha "$VARFILE")
echo "var file ${VARFILE#"$PRIVATE"/} sha256 ${VARSHA:0:16}"

echo "== 3. Plan ($MODE, plan only), the release check, and the record"
STATE=$(state_identity) || die "cannot read the state's serial and lineage"
"$TERRAFORM" -chdir="$TFDIR" plan -input=false -no-color -var-file="$VARFILE" ${EXTRA[@]+"${EXTRA[@]}"} -lock-timeout=60s -out="$PLAN" </dev/null > "$OUT/$T-plan-run.txt" 2>&1 \
  || { tail -30 "$OUT/$T-plan-run.txt"; die "plan failed"; }
"$TERRAFORM" -chdir="$TFDIR" show -no-color "$PLAN" </dev/null > "$OUT/$T.txt"
"$TERRAFORM" -chdir="$TFDIR" show -json "$PLAN" </dev/null > "$OUT/$T.plan.json"
grep -E '^Plan: ' "$OUT/$T.txt" || die "no Plan: line"
node "$HERE/release-check.mjs" "$MODE" "$OUT/$T.plan.json" "$OLD" "$NEW" || die "release check refused the $MODE plan: read why above"
PLANSHA=$(sha "$PLAN")
printf '%s\n' "$STATE" | node "$HERE/plan-record.mjs" write "$PLAN.meta.json" "$MODE" "$COMMIT" "$VARSHA" "$PLANSHA" || die "could not write the plan record"
echo "plan sha256: $PLANSHA"
echo "NOT APPLIED. Read $OUT/$T.txt line by line, then: CLAIM_OWNER=$CLAIM_OWNER $HERE/apply.sh $MODE $COMMIT $PLANSHA"
