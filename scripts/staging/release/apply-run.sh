#!/usr/bin/env bash
# Run by apply.sh, detached, after its gates passed. Not run by hand. Applies exactly the plan file, writes the log, and after an IMAGE
# apply that exits 0 makes the release's var file the canonical one (spec 027, PR 3a).
set -uo pipefail
umask 077
# shellcheck source=scripts/staging/release/lib.sh
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"
MODE="$1"; PLAN="$2"; LOG="$3"; VARFILE="$4"
load_stack
"$TERRAFORM" -chdir="$TFDIR" apply -input=false -no-color "$PLAN" </dev/null > "$LOG" 2>&1
STATUS=$?
if [ "$STATUS" = 0 ] && [ "$MODE" = IMAGE ]; then
  if cp "$VARFILE" "$CURRENT.new" && sha "$CURRENT.new" > "$CURRENT.sha256.new" && mv "$CURRENT.new" "$CURRENT" && mv "$CURRENT.sha256.new" "$CURRENT.sha256"; then
    echo "== current.tfvars is now this release's var file (sha256 $(cut -c1-16 "$CURRENT.sha256"))" >> "$LOG"
  else
    echo "== current.tfvars was NOT updated: copy $VARFILE over it by hand, with its sha256" >> "$LOG"
    STATUS=3
  fi
fi
echo "== apply exit status: $STATUS" >> "$LOG"
