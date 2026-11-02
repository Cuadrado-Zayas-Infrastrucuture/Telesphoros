#!/usr/bin/env bash
# Internal detached runner, called only by apply.sh with reviewed plan/var hashes.
# Rechecks pins before apply and before publishing canonical variables after a successful rollout.
set -uo pipefail
umask 077
# shellcheck source=scripts/staging/release/lib.sh
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"
MODE="$1"; PLAN="$2"; LOG="$3"; VARFILE="$4"
VAR_PIN="${5:-}"; SOURCE_PIN="${6:-}"; PLAN_PIN="${7:-}"
load_stack
pins_match() {
  [[ "$VAR_PIN" =~ ^[0-9a-f]{64}$ && "$PLAN_PIN" =~ ^[0-9a-f]{64}$ ]] || return 1
  [ "$(sha "$PLAN")" = "$PLAN_PIN" ] && [ "$(sha "$VARFILE")" = "$VAR_PIN" ] || return 1
  if [[ "$MODE" = FENCE-CLOSE || "$MODE" = FENCE-OPEN ]]; then
    [[ "$SOURCE_PIN" =~ ^[0-9a-f]{64}$ ]] && [ "$(sha "$CURRENT")" = "$SOURCE_PIN" ] &&
      [ "$(sha "$(dirname "$PLAN")/source.tfvars")" = "$SOURCE_PIN" ] || return 1
  fi
}
if ! pins_match; then
  printf '%s\n' 'REFUSED: reviewed artifacts changed before apply; preserve the claim and evidence' '== apply exit status: 3' > "$LOG"
  exit 3
fi
"$TERRAFORM" -chdir="$TFDIR" apply -input=false -no-color "$PLAN" </dev/null > "$LOG" 2>&1
STATUS=$?
if [ "$STATUS" = 0 ] && { [ "$MODE" = IMAGE ] || [ "$MODE" = FENCE-CLOSE ] || [ "$MODE" = FENCE-OPEN ]; }; then
  if pins_match && cp "$VARFILE" "$CURRENT.new" && [ "$(sha "$CURRENT.new")" = "$VAR_PIN" ] &&
    sha "$CURRENT.new" > "$CURRENT.sha256.new" && mv "$CURRENT.new" "$CURRENT" && mv "$CURRENT.sha256.new" "$CURRENT.sha256"; then
    echo "== current.tfvars is now this release's var file (sha256 $(cut -c1-16 "$CURRENT.sha256"))" >> "$LOG"
  else
    echo "== canonical variables could not be published consistently: preserve the claim and evidence for reviewed recovery" >> "$LOG"
    STATUS=3
  fi
fi
echo "== apply exit status: $STATUS" >> "$LOG"
