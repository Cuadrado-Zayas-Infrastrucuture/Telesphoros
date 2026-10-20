#!/usr/bin/env bash
# Publish the production frontend build to the web bucket (FD-7 slice 2). Synthetic staging only; run from a person's shell.
#
#   scripts/staging/publish-frontend.sh          dry run (default): validates, builds, stages, prints what it would do, uploads nothing
#   scripts/staging/publish-frontend.sh --yes    uploads (needs the AWS CLI and credentials for the account that owns the bucket)
#
# Required environment (none of the VITE values is secret: they are compiled into the public bundle):
#   WEB_BUCKET            terraform output web_bucket
#   VITE_OIDC_AUTHORITY   terraform output cognito_issuer
#   VITE_OIDC_CLIENT_ID   terraform output cognito_app_client_id
#   VITE_COGNITO_DOMAIN   terraform output cognito_sign_in_domain
#   VITE_API_BASE_URL     https://api.<web_domain>, without a path (the app appends /api/v1/...)
# Optional:
#   WEB_DISTRIBUTION_ID   terraform output web_distribution_id; when set, an invalidation of /* is requested after the upload
#   DIST_DIR              publish this existing build instead of building (used by the test; the bundle check below still applies)
#
# Docs: docs/ops/frontend-publish.md
set -euo pipefail

die() { echo "publish-frontend: $*" >&2; exit 1; }

apply=0
for arg in "$@"; do
  case "$arg" in
    --yes) apply=1 ;;
    *) die "unknown argument: $arg (the only option is --yes)" ;;
  esac
done

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# ---- 1. The settings: present, https only, and not a placeholder -------------------------------------------------------
for name in WEB_BUCKET VITE_OIDC_AUTHORITY VITE_OIDC_CLIENT_ID VITE_COGNITO_DOMAIN VITE_API_BASE_URL; do
  [[ -n "${!name:-}" ]] || die "$name is not set (see the header of this script)"
  [[ "${!name}" != *[[:space:]]* ]] || die "$name contains whitespace"
  case "${!name}" in
    *XXXX*|*your-prefix*|*example*|*placeholder*|*changeme*|*CHANGE_ME*|*"<"*|*">"*) die "$name looks like a placeholder: ${!name}" ;;
  esac
done
for name in VITE_OIDC_AUTHORITY VITE_COGNITO_DOMAIN VITE_API_BASE_URL; do
  [[ "${!name}" =~ ^https://[a-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9_./-]*)?$ ]] || die "$name must be an https:// address (found: ${!name})"
  [[ "${!name}" != https://localhost* && "${!name}" != https://127.* && "${!name}" != https://\[* ]] || die "$name must not point at this machine: ${!name}"
done
# The app appends /api/v1/me itself; a path here would be doubled.
[[ "$VITE_API_BASE_URL" =~ ^https://[^/]+$ ]] || die "VITE_API_BASE_URL must have no path (the app appends /api/v1): ${VITE_API_BASE_URL}"
[[ "$WEB_BUCKET" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || die "WEB_BUCKET is not a bucket name (no s3:// prefix): $WEB_BUCKET"
if [[ -n "${WEB_DISTRIBUTION_ID:-}" ]]; then
  [[ "$WEB_DISTRIBUTION_ID" =~ ^E[A-Z0-9]{8,20}$ ]] || die "WEB_DISTRIBUTION_ID is not a CloudFront distribution id: $WEB_DISTRIBUTION_ID"
fi
# The local owned-storage build is for a loopback address only and must never be published.
for name in VITE_LOCAL_STORAGE_INTAKE VITE_LOCAL_REVIEW_S3_ORIGIN VITE_REPORT_STORAGE_ORIGINS; do
  [[ -z "${!name:-}" ]] || die "$name is set: it belongs to a local or end-to-end build and must not reach the published bundle"
done
# The same settings can arrive through a file: Vite reads apps/frontend/.env, .env.local, .env.production and .env.production.local at
# build time. Only the two tracked examples may sit there.
for env_file in "$repo_root"/apps/frontend/.env*; do
  [[ -e "$env_file" ]] || continue
  case "${env_file##*/}" in
    .env.example|.env.e2e) ;;
    *) die "apps/frontend/${env_file##*/} exists: Vite would read it into the published build. Remove it (or move it away) first" ;;
  esac
done

# ---- 2. The build (or the build the caller names) ----------------------------------------------------------------------
if [[ -n "${DIST_DIR:-}" ]]; then
  dist="$DIST_DIR"
  echo "using the existing build in $dist (not building)"
else
  dist="$repo_root/apps/frontend/dist"
  echo "building the production frontend"
  export VITE_OIDC_AUTHORITY VITE_OIDC_CLIENT_ID VITE_COGNITO_DOMAIN VITE_API_BASE_URL
  (cd "$repo_root" && pnpm --filter @telesphoros/frontend build)
fi
[[ -f "$dist/index.html" ]] || die "no index.html in $dist"
[[ -d "$dist/assets" ]] || die "no assets directory in $dist"

# ---- 3. The upload set: the build without source maps and without vite's build manifest (.vite/, a build-time file), checked, in a directory of its own ----
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
(cd "$dist" && find . -type f ! -name '*.map' ! -path './.vite/*' -print0 | while IFS= read -r -d '' file; do mkdir -p "$stage/$(dirname "$file")"; cp "$file" "$stage/$file"; done)
maps_left="$(find "$stage" -type f -name '*.map' | head -n 1)"
[[ -z "$maps_left" ]] || die "a source map is in the upload set: $maps_left"
hidden="$(find "$stage" -name '.*' ! -path "$stage" | head -n 1)"
[[ -z "$hidden" ]] || die "a hidden file is in the upload set: $hidden"
[[ -f "$stage/index.html" ]] || die "index.html is missing from the upload set"
excluded="$(cd "$dist" && find . -type f -name '*.map' | wc -l | tr -d ' ')"
# Check all four compiled public settings, including the sign-in client and logout domain.
# Quoted string literals prevent a stale value with the expected value as a prefix from passing.
for name in VITE_API_BASE_URL VITE_OIDC_AUTHORITY VITE_OIDC_CLIENT_ID VITE_COGNITO_DOMAIN; do
  # The production minifier uses backticks today; accept all three JavaScript string delimiters.
  literal="$(node -e '
    const value = process.argv[1];
    const slash = String.fromCharCode(92);
    const quoted = (code) => {
      const quote = String.fromCharCode(code);
      let body = value.replaceAll(slash, slash + slash).replaceAll(quote, slash + quote);
      if (code === 96) body = body.replaceAll("${", slash + "${");
      return quote + body + quote;
    };
    process.stdout.write([JSON.stringify(value), quoted(39), quoted(96)].join("\n"));
  ' -- "${!name}")"
  grep -rqF -- "$literal" "$stage/assets" || die "the build does not contain $name (${!name}): it was not built with these settings"
done
files="$(find "$stage" -type f | wc -l | tr -d ' ')"

# ---- 4. What happens ---------------------------------------------------------------------------------------------------
echo "upload set: $files files ($excluded source maps left out), bucket s3://$WEB_BUCKET"
steps=(
  "aws s3 sync $stage/assets s3://$WEB_BUCKET/assets --cache-control public,max-age=31536000,immutable --only-show-errors"
  "aws s3 sync $stage s3://$WEB_BUCKET --exclude assets/* --exclude index.html --cache-control no-cache --only-show-errors"
  "aws s3 cp $stage/index.html s3://$WEB_BUCKET/index.html --cache-control no-cache --content-type text/html --only-show-errors"
)
[[ -z "${WEB_DISTRIBUTION_ID:-}" ]] || steps+=("aws cloudfront create-invalidation --distribution-id $WEB_DISTRIBUTION_ID --paths /*")
steps+=("aws s3 ls s3://$WEB_BUCKET/ --recursive  (then refuse if any *.map is listed)")
if [[ "$apply" -ne 1 ]]; then
  echo "dry run: nothing uploaded. It would run, in order:"
  for step in "${steps[@]}"; do echo "  $step"; done
  echo "run again with --yes to upload"
  exit 0
fi

# ---- 5. The upload: hashed assets first, index.html last, nothing deleted ----------------------------------------------
command -v aws >/dev/null || die "the AWS CLI is not installed"
echo "uploading as:"
aws sts get-caller-identity --query '[Account,Arn]' --output text
aws s3 sync "$stage/assets" "s3://$WEB_BUCKET/assets" --cache-control "public,max-age=31536000,immutable" --only-show-errors
aws s3 sync "$stage" "s3://$WEB_BUCKET" --exclude "assets/*" --exclude "index.html" --cache-control "no-cache" --only-show-errors
aws s3 cp "$stage/index.html" "s3://$WEB_BUCKET/index.html" --cache-control "no-cache" --content-type "text/html" --only-show-errors
if [[ -n "${WEB_DISTRIBUTION_ID:-}" ]]; then
  aws cloudfront create-invalidation --distribution-id "$WEB_DISTRIBUTION_ID" --paths "/*" --query 'Invalidation.Id' --output text
fi
listing="$(aws s3 ls "s3://$WEB_BUCKET/" --recursive)"
if grep -q '\.map$' <<<"$listing"; then
  die "a source map is in the bucket: $(grep '\.map$' <<<"$listing" | head -n 1) (delete it; versioning keeps the old copy)"
fi
echo "published $files files to s3://$WEB_BUCKET (old hashed assets are kept on purpose so open tabs keep working)"
