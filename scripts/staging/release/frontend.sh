#!/usr/bin/env bash
# The frontend step of a release onto running synthetic staging (spec 027, PR 3b; docs/ops/frontend-publish.md: the same commit as the API,
# published only after API readiness). Founder-run, under the claim. Needs API_BASE_URL and APP_URL in stack.env.
#   CLAIM_OWNER=NAME scripts/staging/release/frontend.sh DRY COMMIT       builds and checks; uploads nothing (publish-dry.txt)
#   CLAIM_OWNER=NAME scripts/staging/release/frontend.sh PUBLISH COMMIT   uploads assets, the rest, then index.html last (publish.txt)
# Runs the repository's own scripts/staging/publish-frontend.sh in the build worktree the image step made (<clone>-release-<commit8>), with the
# pinned Node and pnpm and the public settings from Terraform outputs. It builds with --with-synthetic-assessment exactly when current.tfvars
# switches the assessment on, and only after verify.sh passed after the last apply, for the current.tfvars that runs now. PUBLISH needs a DRY
# run made against the same current.tfvars, and refuses after a finished PUBLISH.
set -euo pipefail
umask 077
# shellcheck source=scripts/staging/release/lib.sh
. "$(cd "$(dirname "$0")" && pwd)/lib.sh"
MODE="${1:-}"
case "$MODE" in DRY|PUBLISH) ;; *) die "usage: frontend.sh DRY|PUBLISH COMMIT (DRY first)" ;; esac
COMMIT="${2:-}"
release_folder "$COMMIT"
load_stack
[[ "${API_BASE_URL:-}" =~ ^https://[a-z0-9.-]+$ ]] || die "API_BASE_URL in stack.env is not https://<host> without a path"
[[ "${APP_URL:-}" =~ ^https://[a-z0-9.-]+$ ]] || die "APP_URL in stack.env is not https://<host> without a path"
W="$C-release-${COMMIT:0:8}"
[ -d "$OUT" ] || die "no $OUT: the image step has not run"
CURSHA=$(sha "$CURRENT")
# The newest verify-ok.txt of this release must be newer than its newest apply log and name the current.tfvars sha256: the same file can
# come back after ON, OFF and ON again, but each apply is a new task definition revision, verified or not.
VERIFIED=$(node -e '
const fs = require("fs"), path = require("path");
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const files = walk(process.argv[1]), t = (f) => fs.statSync(f).mtimeMs;
const newest = (re) => files.filter((f) => re.test(path.basename(f))).sort((a, b) => t(b) - t(a))[0];
const v = newest(/^verify-ok\.txt$/), a = newest(/-apply\.txt$/);
if (!v || !a || t(v) <= t(a) || !fs.readFileSync(v, "utf8").split("\n").includes("current " + process.argv[2])) process.exit(1);
console.log(v);' "$OUT" "$CURSHA") || die "no verify-ok.txt for the current.tfvars that runs now, newer than the last apply: run verify.sh after the last apply first"
ASSESS=0; grep -Eq '^synthetic_assessment_enabled[[:space:]]*=[[:space:]]*true' "$CURRENT" && ASSESS=1
STAMP="current $CURSHA assessment $ASSESS"
if [ "$MODE" = PUBLISH ]; then
  [ -f "$OUT/publish-dry.ok" ] || die "no publish-dry.ok: run DRY first and read publish-dry.txt"
  [ "$(cat "$OUT/publish-dry.ok")" = "$STAMP" ] || die "the DRY run was made against another current.tfvars: run DRY again"
  [ ! -e "$OUT/publish.txt" ] || die "publish.txt exists: this frontend was already published; tell Claude"
fi
step_lock publish
[ "$MODE" = DRY ] && rm -f "$OUT/publish-dry.ok" # only a DRY run that finishes leaves one
LOG="$OUT/publish-dry.txt"; [ "$MODE" = PUBLISH ] && LOG="$OUT/publish.txt.partial"
exec > >(tee "$LOG") 2>&1
echo "release frontend $MODE ${COMMIT:0:8} started $(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo "== 1. Gates"
claim_check
gate_node
gate_identity
gate_clone "$COMMIT"
echo "verified: ${VERIFIED#"$PRIVATE"/}; the synthetic assessment is $([ "$ASSESS" = 1 ] && echo on || echo off) in current.tfvars"
[ "$(git -C "$W" rev-parse HEAD 2>/dev/null)" = "$COMMIT" ] || die "the build worktree $W is not at ${COMMIT:0:8}"
[ -z "$(git -C "$W" status --porcelain)" ] || die "the build worktree is not clean"
cd "$W"
PNPM_WANT=$(node -e 'const p=require(process.argv[1]).packageManager||"";process.stdout.write(p.replace(/^pnpm@/,""))' "$W/package.json")
[ "$(pnpm --version </dev/null)" = "$PNPM_WANT" ] || die "pnpm is not $PNPM_WANT (corepack under the pinned node should provide it)"
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$API_BASE_URL/api/v1/ready" </dev/null || true)
[ "$CODE" = 200 ] || die "the API is not ready ($CODE): publish only after API readiness"
live_index() { curl -s --max-time 10 "$APP_URL/" </dev/null | grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' | sed -n 1p || true; }
echo "live index before: $(live_index)"
echo ok

echo "== 2. Dependencies (frozen lockfile)"
pnpm install --frozen-lockfile </dev/null || die "pnpm install failed"

echo "== 3. Public settings from Terraform (none is secret: they are compiled into the bundle)"
export WEB_BUCKET VITE_OIDC_AUTHORITY VITE_OIDC_CLIENT_ID VITE_COGNITO_DOMAIN VITE_API_BASE_URL WEB_DISTRIBUTION_ID
WEB_BUCKET=$(tf_out web_bucket); VITE_OIDC_AUTHORITY=$(tf_out cognito_issuer); VITE_OIDC_CLIENT_ID=$(tf_out cognito_app_client_id)
VITE_COGNITO_DOMAIN=$(tf_out cognito_sign_in_domain); WEB_DISTRIBUTION_ID=$(tf_out web_distribution_id); VITE_API_BASE_URL=$API_BASE_URL
for v in WEB_BUCKET VITE_OIDC_AUTHORITY VITE_OIDC_CLIENT_ID VITE_COGNITO_DOMAIN WEB_DISTRIBUTION_ID; do [ -n "${!v}" ] || die "$v is empty"; done
unset VITE_LOCAL_STORAGE_INTAKE VITE_LOCAL_REVIEW_S3_ORIGIN VITE_REPORT_STORAGE_ORIGINS VITE_SYNTHETIC_PGX_DEMO VITE_SYNTHETIC_ASSESSMENT DIST_DIR
FLAGS=(); [ "$ASSESS" = 1 ] && FLAGS=(--with-synthetic-assessment)

echo "== 4. publish-frontend.sh ($MODE${FLAGS[*]:+, ${FLAGS[*]}})"
if [ "$MODE" = DRY ]; then
  scripts/staging/publish-frontend.sh ${FLAGS[@]+"${FLAGS[@]}"} </dev/null || die "the dry run refused (above)"
  printf '%s\n' "$STAMP" > "$OUT/publish-dry.ok"
  echo "DRY RUN DONE: nothing uploaded. Read publish-dry.txt, then: CLAIM_OWNER=$CLAIM_OWNER $HERE/frontend.sh PUBLISH $COMMIT"
else
  scripts/staging/publish-frontend.sh --yes ${FLAGS[@]+"${FLAGS[@]}"} </dev/null || die "the upload failed (above): tell Claude"
  sleep "${PUBLISH_SETTLE:-5}"
  echo "live index after: $(live_index)"
  mv "$OUT/publish.txt.partial" "$OUT/publish.txt"
  echo "PUBLISHED."
fi
