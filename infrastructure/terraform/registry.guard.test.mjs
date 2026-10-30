// Guards for the API image registry (registry.tf). Imported by guard.test.mjs, so `pnpm test:infra` runs it.
// Like the other guards it reads Terraform TEXT: it cannot prove what AWS will do once applied (`terraform test` plans the shape offline).
// `registryProblems` returns what is wrong with a copy of the text (empty when nothing is); the tests run it on the real file and on deliberately
// broken copies, so every rule has been seen to fail. The synthetic-only `force_delete` is also pinned by the profile guard's ratchet.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const registry = readFileSync(new URL('./registry.tf', import.meta.url), 'utf8');

const squash = (s) => s.replace(/[ \t]+/g, ' ').trim();
/** Terraform text without comment lines, so a rule is checked against what is configured and not against what is said about it. */
const code = (text) => text.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');

/** Every `block { ... }` whose header matches, by brace matching. */
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

/** What is wrong with the registry Terraform text `tf`, as a list of sentences. */
export function registryProblems(tf) {
  const problems = [];
  const text = code(tf);
  const need = (condition, why) => {
    if (!condition) problems.push(why);
  };
  const lines = (body) => new Set(body.split('\n').map(squash).filter(Boolean));

  // Exactly the repository, its lifecycle policy and the registry's scan rule: no repository policy (the execution roles' pull grant is the only
  // access), no replication, no cache.
  const resources = [...text.matchAll(/^resource "([^"]+)" "([^"]+)"/gm)].map((m) => `${m[1]}.${m[2]}`);
  const expected = ['aws_ecr_repository.api', 'aws_ecr_lifecycle_policy.api', 'aws_ecr_registry_scanning_configuration.main'];
  need(
    resources.length === expected.length && expected.every((name) => resources.includes(name)),
    `registry.tf must define exactly ${expected.join(', ')} (found: ${resources.join(', ') || 'none'})`,
  );
  need(!/aws_ecr_repository_policy|aws_ecr_replication|aws_ecr_pull_through|aws_ecr_registry_policy/.test(text), 'no repository policy, replication or pull-through cache: the execution roles are the only readers');

  // The registry's scan rule (2026-10-30): a registry setting with no rules overrides scan_on_push, so pushed images went unscanned.
  const [scanning] = blocks(text, 'resource "aws_ecr_registry_scanning_configuration" "main"');
  const scanningLines = lines(scanning ?? '');
  need(scanning !== undefined, 'the registry scanning configuration must exist: without a rule, the repository scan_on_push is not used');
  need(scanningLines.has('count = local.api_count'), 'the scanning configuration must be counted by local.api_count (off with the rest of API hosting)');
  need(scanningLines.has('scan_type = "BASIC"'), 'basic scanning is the decision (enhanced scanning is a paid Inspector service)');
  need(blocks(scanning ?? '', 'rule').length === 1, 'exactly one scan rule');
  for (const line of ['scan_frequency = "SCAN_ON_PUSH"', 'filter = aws_ecr_repository.api[0].name', 'filter_type = "WILDCARD"']) {
    need(scanningLines.has(line), `the scan rule must scan the API repository on push: missing ${line}`);
  }

  // The repository.
  const [repo] = blocks(text, 'resource "aws_ecr_repository" "api"');
  const repoLines = lines(repo ?? '');
  need(repo !== undefined, 'the repository must exist');
  need(repoLines.has('count = local.api_count'), 'the repository must be counted by local.api_count (off with the rest of API hosting)');
  need(repoLines.has('name = "${local.name}-api"'), 'the repository must be named ${local.name}-api');
  need(repoLines.has('image_tag_mutability = "IMMUTABLE"'), 'tags must be immutable: a tag can never be moved to different content');
  need(repoLines.has('force_delete = local.synthetic'), 'force_delete must follow the synthetic profile and nothing else');
  need(repoLines.has('scan_on_push = true'), 'images must be scanned on push');
  need(repoLines.has('encryption_type = "AES256"'), 'the repository must use AES-256 (a customer-managed key needs decrypt grants on both execution roles first)');
  need(!/kms_key/.test(repo ?? ''), 'no key is named: the AWS-managed AES-256 encryption is the decision');

  // The lifecycle policy: keep the last ten, expire the rest.
  const [policy] = blocks(text, 'resource "aws_ecr_lifecycle_policy" "api"');
  const policyLines = lines(policy ?? '');
  need(policy !== undefined, 'the lifecycle policy must exist');
  need(policyLines.has('count = local.api_count'), 'the lifecycle policy must be counted by local.api_count');
  need(policyLines.has('repository = aws_ecr_repository.api[0].name'), 'the lifecycle policy must belong to the API repository');
  // D5 (specs/002-signed-image-release, 2026-10-20): tagged images only, so image signatures (untagged OCI 1.1 referrers, which ECR expires with their
  // image) never take one of the ten slots.
  for (const line of ['tagStatus = "tagged"', 'tagPatternList = ["*"]', 'countType = "imageCountMoreThan"', 'countNumber = 10', 'action = { type = "expire" }']) {
    need(policyLines.has(line), `the lifecycle policy must keep the last 10 images: missing ${line}`);
  }

  // The output is null while hosting is off (a plain index would fail the default plan).
  const [output] = blocks(text, 'output "api_repository_url"');
  need(output !== undefined && lines(output).has('value = one(aws_ecr_repository.api[*].repository_url)'), 'api_repository_url must be one(aws_ecr_repository.api[*].repository_url), so it is null while hosting is off');
  return problems;
}

test('the registry text has no problems (and the scan found the file: a floor, so an empty read cannot pass)', () => {
  assert.ok(registry.includes('aws_ecr_repository'), 'expected registry.tf to define the repository');
  assert.deepEqual(registryProblems(registry), []);
});

test('the registry guard reports each way the text could be weakened (controls)', () => {
  const weakened = [
    ['ungated repository', 'resource "aws_ecr_repository" "api" {\n  count = local.api_count\n', 'resource "aws_ecr_repository" "api" {\n'],
    ['ungated lifecycle policy', 'resource "aws_ecr_lifecycle_policy" "api" {\n  count      = local.api_count\n', 'resource "aws_ecr_lifecycle_policy" "api" {\n'],
    ['mutable tags', 'image_tag_mutability = "IMMUTABLE"', 'image_tag_mutability = "MUTABLE"'],
    ['force_delete always on', 'force_delete = local.synthetic', 'force_delete = true'],
    ['force_delete always off', 'force_delete = local.synthetic', 'force_delete = false'],
    ['no scan on push', 'scan_on_push = true', 'scan_on_push = false'],
    ['a customer-managed key without grants', 'encryption_type = "AES256"', 'encryption_type = "KMS"\n    kms_key         = aws_kms_key.data.arn'],
    ['renamed repository', 'name  = "${local.name}-api"', 'name  = "${local.name}-other"'],
    ['retention raised', 'countNumber    = 10', 'countNumber    = 1000'],
    ['signatures take image slots again (D5)', 'tagStatus      = "tagged"', 'tagStatus      = "any"'],
    ['retention removed', 'imageCountMoreThan', 'sinceImagePushed'],
    ['policy for another repository', 'repository = aws_ecr_repository.api[0].name', 'repository = "elsewhere"'],
    ['a repository policy', 'output "api_repository_url" {', 'resource "aws_ecr_repository_policy" "api" {\n  repository = aws_ecr_repository.api[0].name\n  policy     = "{}"\n}\n\noutput "api_repository_url" {'],
    ['a plain index in the output', 'one(aws_ecr_repository.api[*].repository_url)', 'aws_ecr_repository.api[0].repository_url'],
    ['output removed', 'output "api_repository_url"', 'output "api_other"'],
    ['scan rule removed', 'resource "aws_ecr_registry_scanning_configuration" "main"', 'resource "terraform_data" "main"'],
    ['ungated scan rule', 'resource "aws_ecr_registry_scanning_configuration" "main" {\n  count     = local.api_count\n', 'resource "aws_ecr_registry_scanning_configuration" "main" {\n'],
    ['scans only on request', 'scan_frequency = "SCAN_ON_PUSH"', 'scan_frequency = "MANUAL"'],
    ['scans another repository', 'filter      = aws_ecr_repository.api[0].name', 'filter      = "elsewhere"'],
    ['enhanced scanning', 'scan_type = "BASIC"', 'scan_type = "ENHANCED"'],
  ];
  for (const [name, from, to] of weakened) {
    assert.ok(registry.includes(from), `the control for "${name}" must match the real text (it does not: fix the control)`);
    assert.ok(registryProblems(registry.replace(from, to)).length > 0, `a weakened text must be reported: ${name}`);
  }
  assert.deepEqual(registryProblems(registry), []); // control: the unchanged text is clean
});
