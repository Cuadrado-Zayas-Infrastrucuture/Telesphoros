// Tests for scripts/staging/verify-image.mjs (INF-03 slice 3, specs/002-signed-image-release T014, T016). Imported by
// infrastructure/terraform/guard.test.mjs, so `pnpm test:infra` runs it. The script runs for real with stand-in `cosign` and `aws` on PATH that
// record every argument (the pattern of run-task.test.mjs). What this cannot prove: that KMS and ECR answer as the stand-ins do. The real cosign
// output format is checked once against a local registry (docs/verification/signed-image-release.md, slice 3).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { RECORD_FORMAT } from './verify-image.mjs';

const script = new URL('./verify-image.mjs', import.meta.url).pathname;
const sandbox = mkdtempSync(join(tmpdir(), 'verify-image-'));
after(() => rmSync(sandbox, { recursive: true, force: true }));

const ACCOUNT = '123456789012';
const REGION = 'us-east-2';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const OTHER = `sha256:${'b'.repeat(64)}`;
const REPO = `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/telesphoros-staging-api`;
const IMAGE = `${REPO}@${DIGEST}`;
const MIGRATE = `${REPO}@${OTHER}`;
const KEY_ARN = `arn:aws:kms:${REGION}:${ACCOUNT}:key/0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0`;
const ALIAS = 'alias/telesphoros-staging-image-signing';
const payload = (digest) => JSON.stringify([{ critical: { identity: { 'docker-reference': `${REPO}@${digest}` }, image: { 'docker-manifest-digest': digest }, type: 'https://sigstore.dev/cosign/sign/v1' }, optional: {} }]);

/** Stand-in `cosign` and `aws`: each writes CALL, its name, then one ARG line per argument to $STUB_LOG, and answers from STUB_* variables. */
function stubDir() {
  const dir = mkdtempSync(join(sandbox, 'stub-'));
  const tool = (name, body) => { writeFileSync(join(dir, name), `#!/usr/bin/env bash\n{ echo CALL; echo "TOOL:${name}"; echo "REGION:\${AWS_REGION-}"; for a in "$@"; do echo "ARG:$a"; done; } >> "$STUB_LOG"\n${body}`); chmodSync(join(dir, name), 0o755); };
  tool('cosign', `case "$1" in
  version) echo "{\\"gitVersion\\": \\"\${STUB_COSIGN_VERSION:-v3.1.3}\\"}" ;;
  verify)
    image="\${!#}"
    var="STUB_VERIFY_\${image##*:}"; status="\${!var:-\${STUB_VERIFY_STATUS:-0}}"
    out="STUB_OUT_\${image##*:}"
    if [ "$status" != 0 ]; then echo "Error: no matching signatures" >&2; exit "$status"; fi
    printf '%s\\n' "\${!out-}" ;;
esac
`);
  tool('aws', `if [ -n "\${STUB_AWS_STATUS-}" ]; then echo "An error occurred (NotFoundException)" >&2; exit "$STUB_AWS_STATUS"; fi
echo "\${STUB_KEY-}"
`);
  return dir;
}

const KEY = JSON.stringify({ arn: KEY_ARN, spec: 'ECC_NIST_P256', usage: 'SIGN_VERIFY', state: 'Enabled' });

/** Runs verify-image with stub tools. Each image's cosign answer is keyed by the last 64 hex characters of its digest. */
function run(argv, { stub = {}, record = join(mkdtempSync(join(sandbox, 'out-')), 'verified-image.json') } = {}) {
  const dir = stubDir();
  const log = join(dir, 'calls.log');
  const env = { PATH: `${dir}:${process.env.PATH}`, HOME: sandbox, STUB_LOG: log, STUB_KEY: KEY,
    [`STUB_OUT_${'a'.repeat(64)}`]: payload(DIGEST), [`STUB_OUT_${'b'.repeat(64)}`]: payload(OTHER), ...stub };
  // Defaults for the flags the case does not set itself (a repeated flag is refused, see below).
  const defaults = Object.entries({ '--name-prefix': 'telesphoros', '--environment': 'staging', '--record': record }).filter(([flag]) => !argv.includes(flag)).flat();
  const result = spawnSync(process.execPath, [script, ...defaults, ...argv], { encoding: 'utf8', env, cwd: sandbox });
  const raw = existsSync(log) ? readFileSync(log, 'utf8') : '';
  const calls = raw.split('CALL\n').filter(Boolean).map((block) => {
    const lines = block.trimEnd().split('\n');
    return { tool: lines[0].slice(5), region: lines[1].slice(7), args: lines.slice(2).map((line) => line.slice(4)) };
  });
  const text = existsSync(record) ? readFileSync(record, 'utf8') : null;
  let written = null;
  try { written = text === null ? null : JSON.parse(text); } catch { written = text; }
  return { ...result, calls, record, written };
}

test('a signed digest: the key is resolved once, each image is verified against that exact key, and the record names both', () => {
  const r = run([IMAGE, MIGRATE]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls.map((c) => c.tool), ['cosign', 'aws', 'cosign', 'cosign']);
  assert.deepEqual(r.calls[0].args, ['version', '--json']);
  assert.deepEqual(r.calls[1].args, ['kms', 'describe-key', '--region', REGION, '--key-id', ALIAS, '--query', 'KeyMetadata.{arn:Arn,spec:KeySpec,usage:KeyUsage,state:KeyState}', '--output', 'json']);
  for (const [call, image] of [[r.calls[2], IMAGE], [r.calls[3], MIGRATE]]) {
    // The key ARN, not the alias: an alias can be repointed between the check and the record.
    assert.deepEqual(call.args, ['verify', '--key', `awskms:///${KEY_ARN}`, '--insecure-ignore-tlog', image]);
    assert.equal(call.region, REGION);
  }
  assert.deepEqual(Object.keys(r.written).sort(), ['cosignVersion', 'environment', 'format', 'images', 'keyAlias', 'keyArn', 'method', 'recordedAt']);
  assert.equal(r.written.format, RECORD_FORMAT);
  assert.equal(r.written.method, 'signature');
  assert.equal(r.written.environment, 'staging');
  assert.equal(r.written.keyAlias, ALIAS);
  assert.equal(r.written.keyArn, KEY_ARN);
  assert.equal(r.written.cosignVersion, 'v3.1.3');
  assert.deepEqual(r.written.images, [IMAGE, MIGRATE]);
  assert.ok(!Number.isNaN(Date.parse(r.written.recordedAt)));
  assert.match(r.stdout, /verified 2 image\(s\) against alias\/telesphoros-staging-image-signing/);
});

test('every refusal writes no record and leaves an existing record exactly as it was', () => {
  const cases = [
    ['unsigned (cosign finds no signature)', [IMAGE], { STUB_VERIFY_STATUS: '10' }, /no signature from the image-signing key/],
    ['signed by another key (cosign exits 1)', [IMAGE], { STUB_VERIFY_STATUS: '1' }, /no signature from the image-signing key/],
    ['only the second image is unsigned', [IMAGE, MIGRATE], { [`STUB_VERIFY_${'b'.repeat(64)}`]: '1' }, /no signature from the image-signing key/],
    ['the signed payload names another digest', [IMAGE], { [`STUB_OUT_${'a'.repeat(64)}`]: payload(OTHER) }, /signed payload is for another digest/],
    ['one of two payloads names another digest', [IMAGE], { [`STUB_OUT_${'a'.repeat(64)}`]: JSON.stringify([...JSON.parse(payload(DIGEST)), ...JSON.parse(payload(OTHER))]) }, /signed payload is for another digest/],
    ['cosign exits 0 with no payload', [IMAGE], { [`STUB_OUT_${'a'.repeat(64)}`]: '' }, /cosign output is not a list of signed payloads/],
    ['cosign exits 0 with an empty list', [IMAGE], { [`STUB_OUT_${'a'.repeat(64)}`]: '[]' }, /cosign output is not a list of signed payloads/],
    ['cosign exits 0 with text', [IMAGE], { [`STUB_OUT_${'a'.repeat(64)}`]: 'verified OK' }, /cosign output is not a list of signed payloads/],
    ['cosign 2', [IMAGE], { STUB_COSIGN_VERSION: 'v2.6.1' }, /cosign 3 is required/],
    ['the key alias does not exist', [IMAGE], { STUB_AWS_STATUS: '254' }, /cannot read the image-signing key/],
    ['the key is not an ECC P-256 signing key', [IMAGE], { STUB_KEY: KEY.replace('ECC_NIST_P256', 'RSA_2048') }, /not an ECC_NIST_P256 SIGN_VERIFY key/],
    ['the key is for encryption', [IMAGE], { STUB_KEY: KEY.replace('SIGN_VERIFY', 'ENCRYPT_DECRYPT') }, /not an ECC_NIST_P256 SIGN_VERIFY key/],
    ['the key is disabled', [IMAGE], { STUB_KEY: KEY.replace('Enabled', 'Disabled') }, /is Disabled/],
    ['the key is in another Region', [IMAGE], { STUB_KEY: KEY.replace(`kms:${REGION}`, 'kms:us-west-2') }, /key ARN is not a KMS key in us-east-2/],
    ['the key is in another account', [IMAGE], { STUB_KEY: KEY.replace(`:${ACCOUNT}:`, ':210987654321:') }, /key ARN is not a KMS key in us-east-2/],
    ['the key id has a path after it', [IMAGE], { STUB_KEY: KEY.replace('d2e1f0"', 'd2e1f0/extra"') }, /key ARN is not a KMS key in us-east-2/],
    ['the key id has uppercase letters', [IMAGE], { STUB_KEY: KEY.replace('0f1e2d3c', '0F1E2D3C') }, /key ARN is not a KMS key in us-east-2/],
    ['the expected ARN is only a part of what was returned', [IMAGE], { STUB_KEY: KEY.replace('"arn:aws', '"x-arn:aws') }, /key ARN is not a KMS key in us-east-2/],
    ['the key has no ARN', [IMAGE], { STUB_KEY: JSON.stringify({ spec: 'ECC_NIST_P256', usage: 'SIGN_VERIFY', state: 'Enabled' }) }, /key ARN is not a KMS key in us-east-2/],
    ['a tag instead of a digest', [`${REPO}:latest`], {}, /an ECR image pinned by digest/],
    ['a tag and a digest', [`${REPO}:v1@${DIGEST}`], {}, /an ECR image pinned by digest/],
    ['not ECR', [`ghcr.io/example/api@${DIGEST}`], {}, /an ECR image pinned by digest/],
    ['images in two Regions', [IMAGE, MIGRATE.replace(REGION, 'us-west-2')], {}, /one Region/],
    ['no image', [], {}, /usage/],
  ];
  for (const [name, argv, stub, reason] of cases) {
    const dir = mkdtempSync(join(sandbox, 'keep-'));
    const record = join(dir, 'verified-image.json');
    writeFileSync(record, 'EARLIER RECORD');
    const r = run(argv, { stub, record });
    assert.notEqual(r.status, 0, `${name}: must be refused`);
    assert.match(r.stderr, reason, `${name}: ${r.stderr}`);
    assert.doesNotMatch(r.stdout, /verified/, `${name}: never says verified`);
    assert.equal(readFileSync(record, 'utf8'), 'EARLIER RECORD', `${name}: the record is untouched`);
  }
  // Checked before any tool runs: a malformed image never reaches cosign or AWS.
  assert.deepEqual(run([`${REPO}:latest`]).calls, []);
});

test('the arguments are strict: the stack name is checked, nothing is guessed, nothing is repeated', () => {
  const cases = [
    ['bad prefix', ['--name-prefix', 'Bad Prefix', IMAGE], /--name-prefix/],
    ['bad environment', ['--environment', 'staging/x', IMAGE], /--environment/],
    ['empty environment', ['--environment', '', IMAGE], /--environment/],
    ['repeated flag', ['--name-prefix', 'telesphoros', '--name-prefix', 'other', IMAGE], /given twice/],
    ['unknown flag', ['--allow-http-registry', IMAGE], /unknown option/],
    ['flag without a value', [IMAGE, '--record'], /needs a value/],
  ];
  for (const [name, argv, pattern] of cases) {
    const r = run(argv);
    assert.notEqual(r.status, 0, name);
    assert.match(r.stderr, pattern, `${name}: ${r.stderr}`);
    assert.deepEqual(r.calls, [], `${name}: no tool ran`);
  }
  for (const missing of ['--name-prefix', '--environment']) {
    const argv = ['--name-prefix', 'telesphoros', '--environment', 'staging', IMAGE];
    argv.splice(argv.indexOf(missing), 2);
    const r = spawnSync(process.execPath, [script, ...argv], { encoding: 'utf8', env: { PATH: '/nonexistent' } });
    assert.match(r.stderr, /usage/, `${missing} is required`);
  }
});

test('break-glass: refused for production, needs a real reason, records it, prints it, and calls neither cosign nor AWS', () => {
  const reason = 'CI down since 09:00, synthetic hotfix for the readiness probe';
  const r = run(['--unsigned-break-glass', reason, IMAGE]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.calls, []);
  assert.deepEqual(Object.keys(r.written).sort(), ['environment', 'format', 'images', 'method', 'reason', 'recordedAt']);
  assert.equal(r.written.method, 'break-glass');
  assert.equal(r.written.reason, reason);
  assert.deepEqual(r.written.images, [IMAGE]);
  assert.match(r.stderr, /BREAK-GLASS: UNSIGNED IMAGE/);
  assert.ok(r.stderr.includes(reason));
  assert.doesNotMatch(r.stdout, /verified/);

  const refusals = [
    ['production', ['--environment', 'production', '--unsigned-break-glass', reason, IMAGE], /never allowed for production/],
    ['empty reason', ['--unsigned-break-glass', '', IMAGE], /reason/],
    ['short reason', ['--unsigned-break-glass', 'urgent', IMAGE], /reason/],
    ['multi-line reason', ['--unsigned-break-glass', `${reason}\nsecond line`, IMAGE], /reason/],
    ['long reason', ['--unsigned-break-glass', 'x'.repeat(301), IMAGE], /reason/],
    ['no image', ['--unsigned-break-glass', reason], /usage/],
    ['a tag', ['--unsigned-break-glass', reason, `${REPO}:latest`], /an ECR image pinned by digest/],
  ];
  for (const [name, argv, pattern] of refusals) {
    const out = run(argv);
    assert.notEqual(out.status, 0, name);
    assert.match(out.stderr, pattern, `${name}: ${out.stderr}`);
    assert.equal(out.written, null, `${name}: no record`);
    assert.deepEqual(out.calls, [], `${name}: no tool ran`);
  }
});
