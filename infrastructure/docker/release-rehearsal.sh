#!/usr/bin/env bash
# Rehearses the image release on every CI run (INF-03 slice 2, specs/002-signed-image-release), against a throwaway local registry and a throwaway key,
# with the SAME commands and flags the `release-image` job uses against ECR and KMS. That job runs only after a merge to main and only once the founder
# has applied the AWS side; this rehearsal is what keeps its commands honest on every pull request in the meantime.
#
# It proves, each with a control that must fail:
#   1. pushing the archive WITHOUT --index keeps the exact index digest CI built and scanned (control: --index wraps it in a new index, another digest);
#   2. signing with --use-signing-config=false --tlog-upload=false contacts nothing public: it succeeds with every outbound proxy closed
#      (control: without --tlog-upload=false, cosign tries the public Rekor log and fails on the closed proxy);
#   3. the signature verifies with its key and is refused with another key, and an unsigned digest is refused.
#
# Usage: release-rehearsal.sh <api.oci.tar> <sha256:index digest>   (cosign, crane and docker on PATH)
set -euo pipefail

archive="${1:?usage: release-rehearsal.sh <archive> <digest>}"
expected="${2:?usage: release-rehearsal.sh <archive> <digest>}"
[[ "$expected" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "not a digest: $expected" >&2; exit 1; }

# A registry for the rehearsal only, pinned by digest, on a loopback port Docker chooses.
REGISTRY_IMAGE=registry:3@sha256:ddf754342cfc8acc51a56d5d0ab6af06826461864460636d8bd5c546dab2a7b8
name="release-rehearsal-$$"
work="$(mktemp -d)"
cleanup() { docker rm -f "$name" >/dev/null 2>&1 </dev/null || true; rm -rf "$work"; }
trap cleanup EXIT

fail() { echo "FAIL $*" >&2; exit 1; }
pass() { echo "PASS $*"; }

docker run -d --rm --name "$name" -p 127.0.0.1::5000 "$REGISTRY_IMAGE" >/dev/null </dev/null
port="$(docker port "$name" 5000/tcp </dev/null | head -1 | sed 's/.*://')"
for _ in $(seq 1 30); do curl -sf "http://127.0.0.1:${port}/v2/" >/dev/null && break; sleep 1; done
curl -sf "http://127.0.0.1:${port}/v2/" >/dev/null || fail "the rehearsal registry did not start"
repo="127.0.0.1:${port}/api"

# 1. Push the scanned archive unchanged.
mkdir "$work/layout"
tar -xf "$archive" -C "$work/layout"
crane push "$work/layout" "$repo:git-rehearsal" >/dev/null
pushed="$(crane digest "$repo:git-rehearsal")"
[ "$pushed" = "$expected" ] || fail "the registry holds $pushed, not the digest CI built and scanned ($expected)"
crane push --index "$work/layout" "$repo:git-control" >/dev/null
[ "$(crane digest "$repo:git-control")" != "$expected" ] || fail "control: pushing with --index should have changed the digest, so the comparison above could not fail"
pass "the archive was pushed without a rebuild: the registry digest is the scanned digest; --index (control) changes it"

# 2. Sign with nothing public reachable.
export COSIGN_PASSWORD=""
(cd "$work" && cosign generate-key-pair --output-key-prefix release >/dev/null 2>&1 && cosign generate-key-pair --output-key-prefix other >/dev/null 2>&1)
closed=(env HTTPS_PROXY=http://127.0.0.1:9 HTTP_PROXY=http://127.0.0.1:9 https_proxy=http://127.0.0.1:9 http_proxy=http://127.0.0.1:9 NO_PROXY=127.0.0.1 no_proxy=127.0.0.1)
if "${closed[@]}" cosign sign --key "$work/other.key" --use-signing-config=false --allow-http-registry --yes "$repo:git-control" >"$work/control.log" 2>&1; then
  fail "control: signing without --tlog-upload=false succeeded with every proxy closed, so the closed proxy proves nothing"
fi
grep -q "rekor" "$work/control.log" || fail "control: signing without --tlog-upload=false failed, but not on the transparency log: $(tail -1 "$work/control.log")"
"${closed[@]}" cosign sign --key "$work/release.key" --use-signing-config=false --tlog-upload=false --allow-http-registry --yes "$repo@$expected" >/dev/null 2>&1 \
  || fail "signing with --use-signing-config=false --tlog-upload=false needed the network"
pass "signed with no public network; without --tlog-upload=false (control) cosign tried the public Rekor log"

# 3. Verify, and refuse what must be refused.
"${closed[@]}" cosign verify --key "$work/release.pub" --insecure-ignore-tlog --allow-http-registry "$repo@$expected" >/dev/null 2>&1 || fail "the signature does not verify with its own key"
if "${closed[@]}" cosign verify --key "$work/other.pub" --insecure-ignore-tlog --allow-http-registry "$repo@$expected" >/dev/null 2>&1; then fail "a signature verified with another key"; fi
unsigned="$(crane digest "$repo:git-control")"
if "${closed[@]}" cosign verify --key "$work/release.pub" --insecure-ignore-tlog --allow-http-registry "$repo@$unsigned" >/dev/null 2>&1; then fail "an unsigned digest verified"; fi
pass "verified with its key; refused with another key; an unsigned digest refused"
