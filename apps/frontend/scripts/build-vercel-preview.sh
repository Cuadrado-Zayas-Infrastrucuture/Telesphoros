#!/usr/bin/env bash
# Design-preview build for Vercel (founder decision 2026-10-16: only the frontend is previewed on Vercel; the product runs
# on AWS). The sign-in and API settings are fixed placeholders on reserved .invalid hosts: pages render, but nothing can
# sign in, upload, or reach any API. Settings inherited from the Vercel project are discarded, so a preview can never be
# pointed at a real backend from the dashboard. Plan: docs/design/plans/vercel-frontend-preview.md.
set -euo pipefail
cd "$(dirname "$0")/.."

for name in $(compgen -e); do
  case "$name" in VITE_*) unset "$name" ;; esac
done

pnpm -F @telesphoros/shared-types build
VITE_API_BASE_URL=https://api.invalid \
VITE_OIDC_AUTHORITY=https://idp.invalid \
VITE_OIDC_CLIENT_ID=design-preview \
VITE_COGNITO_DOMAIN=https://auth.invalid \
  pnpm exec vite build

# Publish no source maps and no build manifest, as the AWS frontend publish does.
rm -rf dist/.vite
find dist -name '*.map' -delete
