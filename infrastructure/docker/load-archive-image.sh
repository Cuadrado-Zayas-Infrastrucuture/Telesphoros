#!/usr/bin/env bash
# Loads the OCI archive's own linux/amd64 image into Docker, so Trivy, the readiness test and the rehearsal run the exact image that is released (INF-03,
# specs/002-signed-image-release). Docker cannot `load` an attested index into a classic store, and a second `--load` build is not the same image: on
# 2026-10-21 its last three layers were rebuilt with other bytes. So the archive is pushed (without --index, which would change the digest) to a throwaway
# local registry, crane writes its linux/amd64 image as a Docker tarball, and Docker loads that. (crane, not `docker pull`: the Docker daemon may run in a VM
# that cannot reach this host's loopback, as on Docker Desktop.)
# Usage: load-archive-image.sh <api.oci.tar> <docker tag>   (crane, docker, node on PATH)
set -euo pipefail

archive="${1:?usage: load-archive-image.sh <archive> <tag>}"
tag="${2:?usage: load-archive-image.sh <archive> <tag>}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
manifest="$(node "$here/image-digest.mjs" manifest "$archive")"

REGISTRY_IMAGE=registry:3@sha256:ddf754342cfc8acc51a56d5d0ab6af06826461864460636d8bd5c546dab2a7b8
name="archive-loader-$$"
work="$(mktemp -d)"
cleanup() { docker rm -f "$name" >/dev/null 2>&1 </dev/null || true; rm -rf "$work"; }
trap cleanup EXIT

docker run -d --rm --name "$name" -p 127.0.0.1::5000 "$REGISTRY_IMAGE" >/dev/null </dev/null
port="$(docker port "$name" 5000/tcp </dev/null | head -1 | sed 's/.*://')"
for _ in $(seq 1 30); do curl -sf "http://127.0.0.1:${port}/v2/" >/dev/null && break; sleep 1; done
curl -sf "http://127.0.0.1:${port}/v2/" >/dev/null || { echo "the local registry did not start" >&2; exit 1; }

mkdir "$work/layout"
tar -xf "$archive" -C "$work/layout"
crane push "$work/layout" "127.0.0.1:${port}/api:archive" >/dev/null 2>"$work/push.log" || { cat "$work/push.log" >&2; exit 1; }
crane tag "127.0.0.1:${port}/api@${manifest}" amd64 2>>"$work/push.log"
crane pull "127.0.0.1:${port}/api:amd64" "$work/image.tar" 2>>"$work/push.log"
docker load --quiet --input "$work/image.tar" >/dev/null </dev/null
docker tag "127.0.0.1:${port}/api:amd64" "$tag" </dev/null
docker rmi "127.0.0.1:${port}/api:amd64" >/dev/null </dev/null
node "$here/image-digest.mjs" same "$archive" "$tag"
