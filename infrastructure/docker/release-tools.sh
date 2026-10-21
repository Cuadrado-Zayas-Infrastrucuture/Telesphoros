#!/usr/bin/env bash
# The exact cosign and crane the image release uses (INF-03 slice 2, specs/002-signed-image-release), each checked against the SHA-256 its release
# publishes before it is installed. Used by the `image` job's release rehearsal and by the `release-image` job, so both run the same binaries.
# Linux x86_64 only (the GitHub runners). Versions were at least two weeks old when pinned; Dependabot does not watch these, so bump them by hand.
set -euo pipefail

dest="${1:?usage: release-tools.sh <install-dir>}"

COSIGN_VERSION=v3.1.3
COSIGN_SHA256=4629c757b7618056f8ddd7e2625ae9fdd94c0372a65049520bc7d9df9efc7f71 # cosign-linux-amd64, from cosign_checksums.txt
CRANE_VERSION=v0.22.1
CRANE_SHA256=0ab7a1d6932a213aed964ce97666c3077fe691c8606413674a8b3e0b9ec4cda0 # go-containerregistry_Linux_x86_64.tar.gz, from checksums.txt

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

curl -fsSL --retry 3 --retry-all-errors -o "$tmp/cosign" "https://github.com/sigstore/cosign/releases/download/${COSIGN_VERSION}/cosign-linux-amd64"
echo "${COSIGN_SHA256}  $tmp/cosign" | sha256sum --check --strict

curl -fsSL --retry 3 --retry-all-errors -o "$tmp/crane.tar.gz" "https://github.com/google/go-containerregistry/releases/download/${CRANE_VERSION}/go-containerregistry_Linux_x86_64.tar.gz"
echo "${CRANE_SHA256}  $tmp/crane.tar.gz" | sha256sum --check --strict
tar -xzf "$tmp/crane.tar.gz" -C "$tmp" crane

mkdir -p "$dest"
install -m 0755 "$tmp/cosign" "$tmp/crane" "$dest/"
# Output captured first: under pipefail, `cmd | grep -q` fails when grep exits early and cmd dies of SIGPIPE.
cosign_version="$("$dest/cosign" version 2>/dev/null)"
grep -q "GitVersion:[[:space:]]*${COSIGN_VERSION}$" <<<"$cosign_version" || { echo "cosign is not ${COSIGN_VERSION}" >&2; exit 1; }
[ "$("$dest/crane" version)" = "${CRANE_VERSION#v}" ] || { echo "crane is not ${CRANE_VERSION}" >&2; exit 1; }
