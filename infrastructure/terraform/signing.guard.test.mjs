// Guards for the image-signing key, the GitHub OIDC trust and the CI release role (signing.tf), audit finding INF-03, specs/002-signed-image-release
// (plan approved 2026-10-20). Imported by guard.test.mjs, so `pnpm test:infra` runs it. The key and the role exist only when API
// hosting is on AND the GitHub repository IDs are set, and the founder applies them after the BAA.
// Like the other guards it reads Terraform TEXT. `signingProblems` returns what is wrong with a copy of the text (empty when nothing is); the tests run it on
// the real file and on deliberately broken copies, so every rule has been seen to fail.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const files = { signing: read('./signing.tf'), registry: read('./registry.tf') };

const squash = (s) => s.replace(/[ \t]+/g, ' ');
const code = (text) => text.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');

function blocks(text, header) {
  const found = [];
  const re = new RegExp(header, 'g');
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let depth = 0;
    let i = text.indexOf('{', m.index);
    const start = i;
    for (; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}' && --depth === 0) break;
    }
    found.push(text.slice(start, i + 1));
  }
  return found;
}

export function signingProblems({ signing, registry }) {
  const problems = [];
  const need = (ok, message) => { if (!ok) problems.push(message); };
  const has = (text, s) => squash(code(text)).includes(squash(s));
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const one = (text, header) => blocks(code(text), esc(header))[0] ?? '';
  const statements = (doc) => blocks(doc, 'statement \\{');
  const bySid = (doc, sid) => statements(doc).find((s) => has(s, `sid = "${sid}"`)) ?? '';

  // Off unless API hosting is on AND the repository is named by its immutable IDs (dormant until the founder sets them).
  need(has(signing, 'image_release_count = local.api_count == 1 && var.github_repository_id != "" ? 1 : 0'), 'the release path must exist only with API hosting on and the GitHub repository ID set');
  for (const r of ['resource "aws_kms_key" "image_signing"', 'resource "aws_kms_alias" "image_signing"', 'resource "aws_iam_role" "image_release"', 'resource "aws_iam_role_policy" "image_release"']) {
    need(has(one(signing, r), 'count = local.image_release_count'), `${r} must be counted by local.image_release_count`);
  }
  need(has(one(signing, 'resource "aws_iam_openid_connect_provider" "github"'), 'count = local.image_release_count == 1 && var.github_oidc_provider_arn == "" ? 1 : 0'), 'the OIDC provider is created only when no existing one is named (D2)');

  // The key: asymmetric, signing only, profile deletion window, its own policy. KMS cannot rotate an asymmetric key, so no rotation flag (D4: manual, annual).
  const key = one(signing, 'resource "aws_kms_key" "image_signing"');
  need(has(key, 'customer_master_key_spec = "ECC_NIST_P256"') && has(key, 'key_usage = "SIGN_VERIFY"'), 'the signing key must be ECC P-256 for signing and verifying only');
  need(!/enable_key_rotation/.test(code(key)), 'the signing key must not set enable_key_rotation: KMS refuses it for asymmetric keys; rotation is manual (D4)');
  need(has(key, 'deletion_window_in_days = local.kms_deletion_days') && has(key, 'policy = data.aws_iam_policy_document.image_signing_key[0].json'), 'the signing key must use the profile deletion window and its own policy');
  need(has(key, 'depends_on = [aws_iam_role.image_release]'), 'the key policy names the role, so the role must exist first (KMS refuses a policy naming an unknown principal)');
  need(has(one(signing, 'resource "aws_kms_alias" "image_signing"'), 'name = "alias/${local.name}-image-signing"'), 'the alias is what cosign signs and verifies with');

  // The key policy: only the release role may sign, and an IAM grant cannot add another signer (explicit deny).
  const keyPolicy = one(signing, 'data "aws_iam_policy_document" "image_signing_key"');
  const deny = bySid(keyPolicy, 'NobodyElseSigns');
  need(has(deny, 'effect = "Deny"') && has(deny, 'actions = ["kms:Sign"]') && has(deny, 'test = "ArnNotEquals"') && has(deny, 'variable = "aws:PrincipalArn"') && has(deny, 'values = [local.image_release_role_arn]'), 'the key policy must deny kms:Sign to every principal except the release role');
  const allow = bySid(keyPolicy, 'TheReleaseRoleSigns');
  need(has(allow, 'actions = ["kms:Sign", "kms:GetPublicKey", "kms:DescribeKey"]') && has(allow, 'identifiers = [local.image_release_role_arn]'), 'the release role may sign, read the public key and describe the key, and nothing more');
  need(!/kms:(Encrypt|Decrypt|ReEncrypt|GenerateDataKey)/.test(code(keyPolicy).replace(bySid(keyPolicy, 'AccountAdministration'), '')), 'no statement but account administration may grant an encryption action');

  // The trust policy (FR-002): every condition, each StringEquals, immutable IDs, main only, the release environment, this workflow file.
  const trust = one(signing, 'data "aws_iam_policy_document" "image_release_trust"');
  need(has(trust, 'actions = ["sts:AssumeRoleWithWebIdentity"]') && has(trust, 'type = "Federated"') && has(trust, 'identifiers = [local.github_oidc_provider_arn]'), 'only the GitHub OIDC provider may assume the release role');
  const conditions = {
    'token.actions.githubusercontent.com:aud': '["sts.amazonaws.com"]',
    'token.actions.githubusercontent.com:repository_id': '[var.github_repository_id]',
    'token.actions.githubusercontent.com:repository_owner_id': '[var.github_repository_owner_id]',
    'token.actions.githubusercontent.com:ref': '["refs/heads/main"]',
    'token.actions.githubusercontent.com:environment': '[var.image_release_environment]',
    'token.actions.githubusercontent.com:job_workflow_ref': '["${var.github_repository}/.github/workflows/ci.yml@refs/heads/main"]',
  };
  const conds = blocks(trust, 'condition \\{');
  for (const [variable, values] of Object.entries(conditions)) {
    const c = conds.find((b) => has(b, `variable = "${variable}"`)) ?? '';
    need(has(c, 'test = "StringEquals"') && has(c, `values = ${values}`), `the trust policy must require ${variable} = ${values} with StringEquals`);
  }
  need(conds.length === Object.keys(conditions).length, `the trust policy must have exactly ${Object.keys(conditions).length} conditions (found ${conds.length})`);
  need(!/StringLike/.test(code(trust)), 'no StringLike in the trust policy: no wildcard branch, environment or workflow');

  // The role's permissions (FR-003): log in, push to the API repository only, sign with the key only.
  const perms = one(signing, 'data "aws_iam_policy_document" "image_release"');
  need(statements(perms).length === 3, 'the release role must have exactly three statements');
  const login = bySid(perms, 'EcrLogin');
  need(has(login, 'actions = ["ecr:GetAuthorizationToken"]') && has(login, 'resources = ["*"]'), 'only GetAuthorizationToken may use a wildcard resource (the API requires it)');
  const push = bySid(perms, 'PushToTheApiRepositoryOnly');
  need(has(push, 'resources = [aws_ecr_repository.api[0].arn]') && !/ecr:\*|DeleteRepository|BatchDeleteImage|SetRepositoryPolicy|PutLifecyclePolicy|PutImageTagMutability/.test(push), 'pushing is limited to the API repository and cannot delete or reconfigure it');
  const sign = bySid(perms, 'SignWithTheImageKeyOnly');
  need(has(sign, 'actions = ["kms:Sign", "kms:GetPublicKey", "kms:DescribeKey"]') && has(sign, 'resources = [aws_kms_key.image_signing[0].arn]'), 'signing is limited to the image-signing key');
  need(!/"\*"/.test(code(perms).replace(login, '')), 'no wildcard resource or action outside the ECR login');

  // The registry (FR-002 edge cases, D2): all three repository values or none; production with API hosting needs the release path.
  const repo = one(registry, 'resource "aws_ecr_repository" "api"');
  need(has(repo, 'condition = (var.github_repository == "") == (var.github_repository_id == "") && (var.github_repository_id == "") == (var.github_repository_owner_id == "")'), 'the three GitHub repository values must be set together or not at all');
  need(has(repo, 'condition = var.environment != "production" || local.image_release_count == 1'), 'production must not get an image registry without the signed release path (INF-03)');

  // D5: count tagged images only, so signatures (untagged OCI 1.1 referrers, expired by ECR with their image) never take a slot.
  const lifecycle = one(registry, 'resource "aws_ecr_lifecycle_policy" "api"');
  need(has(lifecycle, 'tagStatus = "tagged"') && has(lifecycle, 'tagPatternList = ["*"]') && !has(lifecycle, 'tagStatus = "any"'), 'the lifecycle rule must count tagged images only (D5)');
  return problems;
}

test('the signing key, OIDC trust and release role have no problems (and the scan found the file: a floor, so an empty read cannot pass)', () => {
  assert.ok(files.signing.includes('resource "aws_kms_key" "image_signing"') && files.registry.includes('resource "aws_ecr_repository" "api"'));
  assert.deepEqual(signingProblems(files), []);
});

test('the signing guard reports each way the text could be weakened (controls)', () => {
  const s = files.signing;
  const weakened = [
    ['signing', 'the release path always on', 'local.api_count == 1 && var.github_repository_id != "" ? 1 : 0', 'local.api_count'],
    ['signing', 'the key not counted', /(resource "aws_kms_key" "image_signing" \{\n)\s+count\s+= local\.image_release_count\n/, '$1'],
    ['signing', 'the provider always created', 'count          = local.image_release_count == 1 && var.github_oidc_provider_arn == "" ? 1 : 0', 'count          = local.image_release_count'],
    ['signing', 'a symmetric key', 'customer_master_key_spec = "ECC_NIST_P256"', 'customer_master_key_spec = "SYMMETRIC_DEFAULT"'],
    ['signing', 'an encryption key', 'key_usage                = "SIGN_VERIFY"', 'key_usage                = "ENCRYPT_DECRYPT"'],
    ['signing', 'rotation set on an asymmetric key', 'key_usage                = "SIGN_VERIFY"\n', 'key_usage                = "SIGN_VERIFY"\n  enable_key_rotation      = true\n'],
    ['signing', 'the key before the role', /\n\s+depends_on\s+= \[aws_iam_role\.image_release\]\n/, '\n'],
    ['signing', 'no deny on other signers', 'effect    = "Deny"', 'effect    = "Allow"'],
    ['signing', 'the deny exempts everyone', 'test     = "ArnNotEquals"', 'test     = "ArnLike"'],
    ['signing', 'the role may decrypt', 'actions   = ["kms:Sign", "kms:GetPublicKey", "kms:DescribeKey"]\n    resources = ["*"]', 'actions   = ["kms:Sign", "kms:GetPublicKey", "kms:DescribeKey", "kms:Decrypt"]\n    resources = ["*"]'],
    ['signing', 'any branch', 'values   = ["refs/heads/main"]', 'values   = ["refs/heads/*"]'],
    ['signing', 'a wildcard trust', 'test     = "StringEquals"\n      variable = "token.actions.githubusercontent.com:ref"', 'test     = "StringLike"\n      variable = "token.actions.githubusercontent.com:ref"'],
    ['signing', 'the environment not required', /\n\s+condition \{\n\s+test\s+= "StringEquals"\n\s+variable = "token\.actions\.githubusercontent\.com:environment"\n\s+values\s+= \[var\.image_release_environment\]\n\s+\}/, ''],
    ['signing', 'trust by repository name instead of ID', 'variable = "token.actions.githubusercontent.com:repository_id"', 'variable = "token.actions.githubusercontent.com:repository"'],
    ['signing', 'another workflow file may sign', '/.github/workflows/ci.yml@refs/heads/main', '/.github/workflows/rescan.yml@refs/heads/main'],
    ['signing', 'the role pushes anywhere', 'resources = [aws_ecr_repository.api[0].arn]', 'resources = ["*"]'],
    ['signing', 'the role may delete images', '"ecr:PutImage",', '"ecr:PutImage", "ecr:BatchDeleteImage",'],
    ['signing', 'the role signs with any key', 'resources = [aws_kms_key.image_signing[0].arn]', 'resources = ["*"]'],
    ['registry', 'half-configured repository values', 'condition     = (var.github_repository == "") == (var.github_repository_id == "") && (var.github_repository_id == "") == (var.github_repository_owner_id == "")', 'condition     = true'],
    ['registry', 'production without the signed path', 'condition     = var.environment != "production" || local.image_release_count == 1', 'condition     = true'],
    ['registry', 'signatures counted as images', 'tagStatus      = "tagged"\n        tagPatternList = ["*"]', 'tagStatus      = "any"'],
  ];
  for (const [file, name, from, to] of weakened) {
    const broken = files[file].replace(from, to);
    assert.notEqual(broken, files[file], `the control for "${name}" must match the real text (it does not: fix the control)`);
    assert.ok(signingProblems({ ...files, [file]: broken }).length > 0, `a weakened text must be reported: ${name}`);
  }
  assert.ok(s.length > 0);
});
