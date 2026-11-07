#!/usr/bin/env bash
# The stack claim (spec 027, PR 3a): one owner at a time plans or applies against synthetic staging. Founder-run.
#   scripts/staging/release/claim.sh take NAME REASON   take it; refuses when anyone holds it
#   scripts/staging/release/claim.sh release NAME       give it back; refuses unless NAME holds it
#   scripts/staging/release/claim.sh show               who holds it, since when, why
# A claim is never broken by a script. One that looks abandoned (staging-status.sh says so after 24 hours) is asked about, then released by its owner.
set -euo pipefail
umask 077
# shellcheck source=scripts/staging/release/lib.sh
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"
mkdir -p "$STAGING"
case "${1:-}" in
  take)
    [[ "${2:-}" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || die "NAME: 1 to 64 letters, digits, dot, dash or underscore"
    [ -n "${3:-}" ] || die "a REASON is required"
    mkdir "$CLAIM_DIR" 2>/dev/null || die "the claim is held: $(cat "$CLAIM_DIR/owner.json" 2>/dev/null || echo '(no owner file)')"
    NAME="$2" REASON="$3" node -e 'process.stdout.write(JSON.stringify({owner:process.env.NAME,reason:process.env.REASON,started:new Date().toISOString()})+"\n")' > "$CLAIM_DIR/owner.json"
    echo "claim taken by $2"
    ;;
  release)
    [ -f "$CLAIM_DIR/owner.json" ] || die "no claim is held"
    CLAIM_OWNER="${2:-}" claim_check
    rm -f "$CLAIM_DIR/owner.json" && rmdir "$CLAIM_DIR"
    echo "claim released by $2"
    ;;
  show) cat "$CLAIM_DIR/owner.json" 2>/dev/null || echo "no claim is held" ;;
  *) die "usage: claim.sh take NAME REASON | release NAME | show" ;;
esac
