// Run with: pnpm test:ci-config
// INF-03 slice 2 (specs/002-signed-image-release): the image release. Three parts:
//   1. `releaseProblems` reads the workflow and the release scripts as TEXT: the one `id-token: write`, when the release job may run, that it pushes the
//      scanned archive without --index, compares before it signs, and signs with no transparency log. Every rule has a broken copy that must be reported.
//   2. release-image.sh runs against stub `aws`, `crane` and `cosign` (the pattern of scripts/staging/run-task.test.mjs): what it calls, in which order,
//      and what it refuses. The real ECR and KMS calls are proved only at the founder's first apply.
//   3. image-digest.mjs reads a synthetic OCI archive built here.
// The commands themselves run for real in the image job's release rehearsal (release-rehearsal.sh) against a local registry, on every pull request.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { readArchive, sameImage } from '../../infrastructure/docker/image-digest.mjs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const real = {
  workflow: read('../workflows/ci.yml'),
  releaseScript: read('../../infrastructure/docker/release-image.sh'),
  rehearsal: read('../../infrastructure/docker/release-rehearsal.sh'),
  tools: read('../../infrastructure/docker/release-tools.sh'),
  signing: read('../../infrastructure/terraform/signing.tf'),
};
const SCRIPT = new URL('../../infrastructure/docker/release-image.sh', import.meta.url).pathname;

const job = (workflow, key) => {
  const body = workflow.split(/^jobs:\s*$/m)[1] ?? '';
  return body.split(/^  (?=[a-z][a-z0-9-]*:\s*$)/m).find((b) => b.startsWith(`${key}:`)) ?? '';
};
const code = (text) => text.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');

export function releaseProblems({ workflow, releaseScript, rehearsal, tools, signing }) {
  const problems = [];
  const need = (ok, message) => { if (!ok) problems.push(message); };
  const release = job(workflow, 'release-image');
  const image = job(workflow, 'image');

  // The one write permission, and only here.
  need((code(workflow).match(/:\s*write\b/g) ?? []).length === 1, 'exactly one write permission may appear in ci.yml');
  need(/^    permissions:\n      contents: read\n      id-token: write\n(?! {6})/m.test(release), 'release-image must ask for exactly contents: read and id-token: write');
  // When it may run: after the image job, on a push to main, once the founder has set the role variable; in the release environment.
  need(release.includes("    if: github.event_name == 'push' && github.ref == 'refs/heads/main' && vars.IMAGE_RELEASE_ROLE_ARN != ''\n"), 'release-image must run only on a push to main, and only once the role variable is set');
  need(/^    needs: image\n/m.test(release), 'release-image must need the image job');
  const environment = /^variable "image_release_environment" \{[\s\S]*?default\s+= "([^"]+)"/m.exec(signing)?.[1];
  need(environment !== undefined && release.includes(`    environment: ${environment}\n`), "release-image must run in the environment the role's trust policy requires (signing.tf)");
  need(/^    timeout-minutes: \d+\n/m.test(release), 'release-image must have a time limit');
  need(!/continue-on-error/.test(release), 'release-image must fail visibly, never continue on error');
  need(!/secrets\./.test(code(release)), 'release-image must use no repository secret');
  // What it releases: the archive the image job scanned.
  need(/^    outputs:\n      digest: \$\{\{ steps\.digest\.outputs\.digest \}\}\n/m.test(image), 'the image job must output the archive digest');
  need(image.includes('node infrastructure/docker/image-digest.mjs digest "$RUNNER_TEMP/api.oci.tar" >> "$GITHUB_OUTPUT"'), 'the image job must record the digest of its OCI archive');
  const load = image.indexOf('infrastructure/docker/load-archive-image.sh "$RUNNER_TEMP/api.oci.tar" telesphoros-fd4b:rehearsal');
  need(load > 0 && load < image.indexOf('aquasecurity/trivy-action'), "the image job must load the archive's own image before Trivy runs");
  need(!/load: true/.test(code(image)), 'the image job must not scan a second build: it is not the released image (found 2026-10-21)');
  need(image.includes('name: api-image-with-attestations') && release.includes('name: api-image-with-attestations'), 'release-image must download the archive the image job uploaded');
  need(release.includes('test "$(node infrastructure/docker/image-digest.mjs digest "$RUNNER_TEMP/release/api.oci.tar")" = "digest=$IMAGE_DIGEST"'), 'release-image must check the downloaded archive is the scanned one');
  need(release.includes('role-to-assume: ${{ vars.IMAGE_RELEASE_ROLE_ARN }}'), 'release-image must assume the release role through OIDC');
  need(release.includes('run: infrastructure/docker/release-image.sh "$RUNNER_TEMP/release/api.oci.tar"'), 'release-image must run release-image.sh');
  need(image.includes('infrastructure/docker/release-rehearsal.sh "$RUNNER_TEMP/api.oci.tar" "${{ steps.digest.outputs.digest }}"'), 'every image run must rehearse the release');
  for (const [name, text] of [['image', image], ['release-image', release]]) need(text.includes('infrastructure/docker/release-tools.sh "$RUNNER_TEMP/release-tools"'), `${name} must install the pinned release tools`);

  // The release script: no rebuild, compare before sign, no transparency log, no fallback tag.
  const s = code(releaseScript);
  need(/crane push "\$work\/layout" "\$IMAGE_REPOSITORY_URL:\$tag"/.test(s) && !/crane push --index/.test(s), 'release-image.sh must push the archive without --index (--index wraps it in a new index: another digest)');
  need(!/docker build|buildx|docker push/.test(s), 'release-image.sh must never rebuild or push from Docker');
  const compare = s.indexOf('[ "$existing" = "$IMAGE_DIGEST" ]');
  const sign = s.indexOf('cosign sign ');
  need(compare > 0 && compare < sign, 'release-image.sh must compare the registry digest with the scanned digest before signing');
  const signLine = s.split('\n').find((l) => l.includes('cosign sign ')) ?? '';
  need(signLine.includes('--use-signing-config=false') && signLine.includes('--tlog-upload=false'), 'cosign sign must carry --use-signing-config=false AND --tlog-upload=false (cosign 3 uploads to the public Rekor log otherwise)');
  need(signLine.includes('--key "$key"') && s.includes('key="awskms:///${IMAGE_SIGNING_KEY_ALIAS}"'), 'release-image.sh must sign with the KMS key');
  need(signLine.includes('"$IMAGE_REPOSITORY_URL@$IMAGE_DIGEST"'), 'release-image.sh must sign the digest, never a tag');
  need(s.includes('grep -qx "sha256-${IMAGE_DIGEST#sha256:}" <<<"$tags"'), 'release-image.sh must refuse a fallback signature tag (assumption A3)');
  // Under pipefail, `cmd | grep -q` loses matches when grep exits early and cmd dies of SIGPIPE (found by a flaky test here, 2026-10-21).
  for (const [name, text] of [['release-image.sh', releaseScript], ['release-rehearsal.sh', rehearsal], ['release-tools.sh', tools]]) need(!/\|\s*grep -q/.test(code(text)), `${name}: no "| grep -q" under pipefail; capture the output first`);
  need(/cosign verify --key "\$key" --insecure-ignore-tlog "\$IMAGE_REPOSITORY_URL@\$IMAGE_DIGEST"/.test(s), 'release-image.sh must verify what it signed');
  // The rehearsal signs exactly as the release does.
  need(/cosign sign --key "\$work\/release\.key" --use-signing-config=false --tlog-upload=false /.test(code(rehearsal)), 'the rehearsal must sign with the release flags');
  need(/crane push "\$work\/layout" "\$repo:git-rehearsal"/.test(code(rehearsal)), 'the rehearsal must push the way the release does');
  // The tools: exact versions, checked against their published checksums.
  need(/^COSIGN_VERSION=v3\.1\.3$/m.test(tools) && /^COSIGN_SHA256=4629c757b7618056f8ddd7e2625ae9fdd94c0372a65049520bc7d9df9efc7f71 /m.test(tools), 'cosign must be v3.1.3 with its published linux-amd64 checksum');
  need(/^CRANE_VERSION=v0\.22\.1$/m.test(tools) && /^CRANE_SHA256=0ab7a1d6932a213aed964ce97666c3077fe691c8606413674a8b3e0b9ec4cda0 /m.test(tools), 'crane must be v0.22.1 with its published linux-x86_64 checksum');
  need((tools.match(/sha256sum --check --strict/g) ?? []).length === 2, 'both downloads must be checked before install');
  return problems;
}

test('the release workflow and scripts have no problems (and the scan found them: a floor, so an empty read cannot pass)', () => {
  assert.ok(real.workflow.includes('  release-image:') && real.releaseScript.length > 500 && real.rehearsal.length > 500);
  assert.deepEqual(releaseProblems(real), []);
});

test('the release guard reports each way the files could be weakened (controls)', () => {
  const w = real.workflow;
  const weakened = [
    ['workflow', 'a second write permission', "  image:\n    name: image\n", "  image:\n    name: image\n    permissions:\n      contents: write\n"],
    ['workflow', 'the release runs on pull requests', "if: github.event_name == 'push' && github.ref == 'refs/heads/main' && vars.IMAGE_RELEASE_ROLE_ARN != ''", "if: vars.IMAGE_RELEASE_ROLE_ARN != ''"],
    ['workflow', 'the release does not wait for the image job', '    needs: image\n    if: github', '    if: github'],
    ['workflow', 'another environment', '    environment: image-release\n', '    environment: release\n'],
    ['workflow', 'the release may fail quietly', '    timeout-minutes: 15\n    environment', '    timeout-minutes: 15\n    continue-on-error: true\n    environment'],
    ['workflow', 'a repository secret', '      IMAGE_DIGEST: ${{ needs.image.outputs.digest }}\n', '      IMAGE_DIGEST: ${{ needs.image.outputs.digest }}\n      TOKEN: ${{ secrets.TOKEN }}\n'],
    ['workflow', 'no digest output', '      digest: ${{ steps.digest.outputs.digest }}\n', '      digest: latest\n'],
    ['workflow', 'the scanned image not the archive image', /\n {6}- name: Load the archive's image \(the one that is released\)\n {8}run: [^\n]+/, ''],
    ['workflow', 'a second build scanned instead', '          version: v0.70.0', '          version: v0.70.0\n          load: true'],
    ['workflow', 'the downloaded archive not checked', /\n {6}- name: The downloaded archive is the one the image job scanned\n {8}run: [^\n]+/, ''],
    ['workflow', 'no rehearsal', /\n {6}- name: Rehearse the release\n {8}run: [^\n]+/, ''],
    ['releaseScript', 'pushed with --index', 'crane push "$work/layout"', 'crane push --index "$work/layout"'],
    ['releaseScript', 'signed before the comparison', /\[ "\$existing" = "\$IMAGE_DIGEST" \] \|\| \{[^\n]+\n\ncosign sign ([^\n]+)\n/, 'cosign sign $1\n[ "$existing" = "$IMAGE_DIGEST" ] || { exit 1; }\n'],
    ['releaseScript', 'the transparency log comes back (cosign 3)', ' --use-signing-config=false --tlog-upload=false --yes', ' --tlog-upload=false --yes'],
    ['releaseScript', 'the transparency log comes back', ' --use-signing-config=false --tlog-upload=false --yes', ' --use-signing-config=false --yes'],
    ['releaseScript', 'a tag is signed', 'cosign sign --key "$key" --use-signing-config=false --tlog-upload=false --yes "$IMAGE_REPOSITORY_URL@$IMAGE_DIGEST"', 'cosign sign --key "$key" --use-signing-config=false --tlog-upload=false --yes "$IMAGE_REPOSITORY_URL:$tag"'],
    ['releaseScript', 'a fallback tag tolerated', 'grep -qx "sha256-${IMAGE_DIGEST#sha256:}"', 'grep -qx "never"'],
    ['releaseScript', 'the SIGPIPE race comes back', 'tags="$(crane ls "$IMAGE_REPOSITORY_URL")"\nif grep -qx "sha256-${IMAGE_DIGEST#sha256:}" <<<"$tags"; then', 'if crane ls "$IMAGE_REPOSITORY_URL" | grep -qx "sha256-${IMAGE_DIGEST#sha256:}"; then'],
    ['releaseScript', 'a rebuild', 'crane push "$work/layout" "$IMAGE_REPOSITORY_URL:$tag"', 'docker build -t "$IMAGE_REPOSITORY_URL:$tag" . && crane push "$work/layout" "$IMAGE_REPOSITORY_URL:$tag"'],
    ['rehearsal', 'the rehearsal signs differently', '--use-signing-config=false --tlog-upload=false --allow-http-registry --yes "$repo@$expected"', '--tlog-upload=false --allow-http-registry --yes "$repo@$expected"'],
    ['tools', 'cosign unpinned', 'COSIGN_VERSION=v3.1.3', 'COSIGN_VERSION=latest'],
    ['tools', 'a checksum not checked', /echo "\$\{CRANE_SHA256\}  \$tmp\/crane\.tar\.gz" \| sha256sum --check --strict\n/, ''],
    ['signing', 'the trust policy and the workflow name different environments', 'default     = "image-release"', 'default     = "release"'],
  ];
  for (const [file, name, from, to] of weakened) {
    const broken = real[file].replace(from, to);
    assert.notEqual(broken, real[file], `the control for "${name}" must match the real text (it does not: fix the control)`);
    assert.ok(releaseProblems({ ...real, [file]: broken }).length > 0, `a weakened copy must be reported: ${name}`);
  }
  assert.ok(w.length > 0);
});

// ---- release-image.sh against stubs ----------------------------------------------------------------------------------------------------------------
const DIGEST = `sha256:${'a'.repeat(64)}`;
const OTHER = `sha256:${'b'.repeat(64)}`;
const REPO = '123456789012.dkr.ecr.us-east-2.amazonaws.com/telesphoros-staging-api';

function runRelease({ ecrDigest = '', pushDigest = DIGEST, tags = 'git-0123456789ab\n', env = {}, verifyExit = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'release-stub-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    const log = join(dir, 'calls.log');
    const state = join(dir, 'ecr-digest');
    if (ecrDigest) writeFileSync(state, ecrDigest);
    const stub = (name, body) => { writeFileSync(join(bin, name), `#!/usr/bin/env bash\necho "${name} $*" >> "${log}"\n${body}\n`); chmodSync(join(bin, name), 0o755); };
    stub('aws', `case "$*" in *get-login-password*) echo synthetic-password;; *describe-images*) [ -f "${state}" ] && cat "${state}" || exit 254;; esac`);
    // Like the real crane, `auth login --password-stdin` reads its input; a stub that did not would make the login pipe die of SIGPIPE at random.
    stub('crane', `case "$1" in auth) cat >/dev/null;; push) echo -n "${pushDigest}" > "${state}";; ls) printf '%b' "${tags.replace(/\n/g, '\\n')}";; esac`);
    stub('cosign', `case "$1" in verify) exit ${verifyExit};; esac`);
    const archive = join(dir, 'api.oci.tar');
    mkdirSync(join(dir, 'content'));
    writeFileSync(join(dir, 'content', 'index.json'), '{}');
    spawnSync('tar', ['-cf', archive, '-C', join(dir, 'content'), 'index.json']);
    const summary = join(dir, 'summary.md');
    const result = spawnSync('bash', [SCRIPT, archive], {
      encoding: 'utf8',
      env: { PATH: `${bin}:${process.env.PATH}`, AWS_REGION: 'us-east-2', IMAGE_REPOSITORY_URL: REPO, IMAGE_SIGNING_KEY_ALIAS: 'alias/telesphoros-staging-image-signing', IMAGE_DIGEST: DIGEST, GITHUB_SHA: '0123456789abcdef0123456789abcdef01234567', GITHUB_STEP_SUMMARY: summary, ...env },
    });
    const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
    return { status: result.status, stderr: result.stderr, calls, summary: existsSync(summary) ? readFileSync(summary, 'utf8') : '' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('release-image.sh pushes the archive under git-<sha>, checks the digest, signs it with KMS and no transparency log, and verifies it', () => {
  const r = runRelease();
  assert.equal(r.status, 0, r.stderr);
  const pushIndex = r.calls.findIndex((c) => c.startsWith('crane push '));
  const signIndex = r.calls.findIndex((c) => c.startsWith('cosign sign '));
  assert.ok(pushIndex >= 0 && signIndex > pushIndex);
  assert.match(r.calls[pushIndex], new RegExp(`^crane push \\S+/layout ${REPO}:git-0123456789ab$`));
  assert.equal(r.calls[signIndex], `cosign sign --key awskms:///alias/telesphoros-staging-image-signing --use-signing-config=false --tlog-upload=false --yes ${REPO}@${DIGEST}`);
  assert.ok(r.calls.some((c) => c === `cosign verify --key awskms:///alias/telesphoros-staging-image-signing --insecure-ignore-tlog ${REPO}@${DIGEST}`));
  assert.match(r.summary, new RegExp(`${REPO}@${DIGEST}`));
});

test('a rerun finds its own image under the immutable tag, does not push again, and signs', () => {
  const r = runRelease({ ecrDigest: DIGEST });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.calls.some((c) => c.startsWith('crane push ')));
  assert.ok(r.calls.some((c) => c.startsWith('cosign sign ')));
});

test('release-image.sh refuses, before signing: a tag holding another image, a push that changed the digest, a fallback signature tag, a failed verify', () => {
  for (const [name, options] of [
    ['the tag holds another image', { ecrDigest: OTHER }],
    ['the registry digest differs after the push', { pushDigest: OTHER }],
  ]) {
    const r = runRelease(options);
    assert.notEqual(r.status, 0, name);
    assert.ok(!r.calls.some((c) => c.startsWith('cosign sign ')), `${name}: nothing may be signed`);
  }
  const fallback = runRelease({ tags: `git-0123456789ab\nsha256-${'a'.repeat(64)}\n` });
  assert.notEqual(fallback.status, 0, 'a fallback signature tag must stop the release');
  assert.match(fallback.stderr, /assumption A3/);
  assert.notEqual(runRelease({ verifyExit: 1 }).status, 0, 'a signature that does not verify must fail the release');
});

test('release-image.sh refuses malformed inputs before calling AWS', () => {
  for (const env of [{ IMAGE_DIGEST: 'latest' }, { IMAGE_REPOSITORY_URL: 'docker.io/library/api' }, { IMAGE_SIGNING_KEY_ALIAS: 'arn:aws:kms:x' }, { IMAGE_SIGNING_KEY_ALIAS: '' }]) {
    const r = runRelease({ env });
    assert.notEqual(r.status, 0, JSON.stringify(env));
    assert.equal(r.calls.length, 0, `${JSON.stringify(env)}: no command may run`);
  }
});

// ---- image-digest.mjs ------------------------------------------------------------------------------------------------------------------------------
function archive(entries) {
  const files = new Map();
  const put = (object) => { const text = JSON.stringify(object); const digest = `sha256:${createHash('sha256').update(text).digest('hex')}`; files.set(`blobs/sha256/${digest.slice(7)}`, text); return digest; };
  return { files, put, read: (path) => { if (path === 'index.json') return JSON.stringify(entries(put)); if (!files.has(path)) throw new Error(`missing ${path}`); return files.get(path); } };
}

test('image-digest reads the index digest and the linux/amd64 image from an OCI archive', () => {
  let expected;
  const a = archive((put) => {
    const config = `sha256:${'c'.repeat(64)}`;
    const manifest = put({ config: { digest: config } });
    const attestation = put({ config: { digest: `sha256:${'d'.repeat(64)}` } });
    expected = { manifest, config };
    const index = put({ manifests: [{ digest: manifest, platform: { os: 'linux', architecture: 'amd64' } }, { digest: attestation, platform: { os: 'unknown', architecture: 'unknown' } }] });
    expected.digest = index;
    return { manifests: [{ mediaType: 'application/vnd.oci.image.index.v1+json', digest: index }] };
  });
  const result = readArchive('unused', a.read);
  assert.deepEqual(result, expected);
  assert.equal(sameImage(result, expected.config), true);
  assert.equal(sameImage(result, expected.manifest), false, 'only the config digest pins the filesystem (the manifest digest depends on the format)');
  assert.equal(sameImage(result, `sha256:${'e'.repeat(64)}`), false, 'another image is not the archive image');
  assert.equal(sameImage(result, ''), false);
});

test('image-digest refuses an archive with no index, two indexes, or no linux/amd64 image', () => {
  assert.throws(() => readArchive('x', archive(() => ({ manifests: [] })).read));
  assert.throws(() => readArchive('x', archive(() => ({ manifests: [{ mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: `sha256:${'a'.repeat(64)}` }] })).read));
  const noAmd64 = archive((put) => ({ manifests: [{ mediaType: 'application/vnd.oci.image.index.v1+json', digest: put({ manifests: [{ digest: put({ config: { digest: `sha256:${'c'.repeat(64)}` } }), platform: { os: 'linux', architecture: 'arm64' } }] }) }] }));
  assert.throws(() => readArchive('x', noAmd64.read), /linux\/amd64/);
});

test('load-archive-image.sh pushes without --index and ends by checking the loaded image is the archive image', () => {
  const s = code(read('../../infrastructure/docker/load-archive-image.sh'));
  assert.match(s, /crane push "\$work\/layout" "127\.0\.0\.1:\$\{port\}\/api:archive"/);
  assert.doesNotMatch(s, /crane push --index|docker build|buildx/);
  assert.match(s.trim().split('\n').at(-1), /^node "\$here\/image-digest\.mjs" same "\$archive" "\$tag"$/);
});
