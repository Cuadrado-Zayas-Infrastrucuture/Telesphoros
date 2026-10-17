// Source tripwires only: private runtime config and AWS acceptance need separate review.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const versions = read('./versions.tf');
let example = '';
try { example = read('./backend.s3.tfbackend.example'); } catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const ignores = read('../../.gitignore');
// Preserve quoted strings while removing all three HCL comment forms. Native validate
// remains the syntax authority; these checks cover this deliberately flat contract.
const code = text => text.replace(/"(?:\\.|[^"\\])*"|#[^\n]*|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
  match => match.startsWith('"') ? match : '');

function backendProblems(source, config) {
  const problems = [];
  const text = code(source);
  const blocks = [...text.matchAll(/\bbackend\s+"([^"]+)"\s*\{([^{}]*)\}/g)];
  if (blocks.length !== 1 || blocks[0][1] !== 's3') problems.push('one S3 backend');
  const settings = blocks[0]?.[2].trim().split('\n').map(line => line.trim()).filter(Boolean) ?? [];
  // Ignore alignment, but reject other fields, false values and duplicate assignments.
  const normalized = settings.map(line => line.replace(/\s+/g, ' ')).sort();
  if (JSON.stringify(normalized) !== JSON.stringify(['encrypt = true', 'use_lockfile = true'])) problems.push('encryption and native locking only, both true');
  if (!/\brequired_version\s*=\s*">= 1\.11"/.test(text)) problems.push('project Terraform floor');
  const fields = code(config).trim().split('\n').map(line => line.trim()).filter(Boolean);
  const expected = ['bucket', 'key', 'kms_key_id', 'region'];
  const names = fields.map(line => /^([a-z_]+)\s*=\s*"<[^"<>]+>"$/.exec(line)?.[1]);
  if (JSON.stringify(names.sort()) !== JSON.stringify(expected)) problems.push('four placeholder-only backend strings');
  return problems;
}

const livePaths = ['infrastructure/terraform/backend.s3.tfbackend', 'infrastructure/terraform/backend.s3.tfbackend.bak'];
const trackedPaths = ['infrastructure/terraform/backend.s3.tfbackend.example', 'infrastructure/terraform/.terraform.lock.hcl',
  'infrastructure/terraform-state/.terraform.lock.hcl'];
function ignoredPaths(rules) {
  const directory = mkdtempSync(join(tmpdir(), 'telesphoros-backend-ignore-'));
  // Only this function's disposable directory is removed; no checkout is used.
  try {
    const env = { PATH: process.env.PATH, HOME: directory, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
    const git = args => {
      const result = spawnSync('git', args, { cwd: directory, env, encoding: 'utf8', input: [...livePaths, ...trackedPaths].join('\0') + '\0' });
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      return result;
    };
    assert.equal(git(['init', '-q', '--template=']).status, 0);
    writeFileSync(join(directory, '.gitignore'), rules);
    const result = git(['check-ignore', '--no-index', '--stdin', '-z']);
    assert.ok([0, 1].includes(result.status), `git check-ignore failed: ${result.stderr}`);
    return result.stdout.split('\0').filter(Boolean).sort();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('main backend source declares the reviewed S3 contract', () => {
  assert.deepEqual(backendProblems(versions, example), []);
});

test('live backend config and backups are ignored; example and provider locks remain trackable', () => {
  assert.deepEqual(ignoredPaths(ignores), [...livePaths].sort());
});

const defects = [
  ['missing backend', text => text.replace(/\s*backend "s3" \{[^}]*\}/, '')],
  ['wrong backend type', text => text.replace('backend "s3"', 'backend "local"')],
  ['duplicate backend', text => text.replace('backend "s3" {', 'backend "local" {}\n  backend "s3" {')],
  ['missing encryption', text => text.replace(/^\s*encrypt\s*= true\n/m, '')],
  ['disabled encryption', text => text.replace(/encrypt\s*= true/, 'encrypt = false')],
  ['missing locking', text => text.replace(/^\s*use_lockfile\s*= true\n/m, '')],
  ['disabled locking', text => text.replace(/use_lockfile\s*= true/, 'use_lockfile = false')],
  ['hash-commented locking', text => text.replace('use_lockfile = true', '# use_lockfile = true')],
  ['slash-commented encryption', text => text.replace(/encrypt\s*= true/, '// encrypt = true')],
  ['block-commented backend', text => text.replace(/backend "s3" \{[^}]*\}/, match => `/* ${match} */`)],
  ['lower Terraform floor', text => text.replace('>= 1.11', '>= 1.6')],
  ['credentials in source', text => text.replace('backend "s3" {', 'backend "s3" {\n    access_key = "synthetic-forbidden"')],
];
for (const [name, change] of defects) test(`backend tripwire rejects ${name}`, () => {
  const changed = change(versions);
  assert.notEqual(changed, versions, 'the defect must actually change its source');
  assert.ok(backendProblems(changed, example).length > 0, name);
});

for (const [name, config] of [
  ['missing config field', () => example.replace(/^bucket\s*=.*\n/m, '')],
  ['live-looking value', () => example.replace(/<[^<>]+>/, 'synthetic-example-bucket')],
  ['credential field', () => example + '\naccess_key = "<FORBIDDEN>"\n'],
  ['locking override', () => example + '\nuse_lockfile = false\n'],
  ['workspace override', () => example + '\nworkspace_key_prefix = "<FORBIDDEN>"\n'],
]) test(`backend example rejects ${name}`, () => {
  const changed = config();
  assert.notEqual(changed, example);
  assert.ok(backendProblems(versions, changed).length > 0, name);
});

for (const [name, change] of [
  ['trackable live config', text => text.replace(/^\*\.tfbackend\n/m, '')],
  ['trackable backup config', text => text.replace(/^\*\.tfbackend\.\*\n/m, '')],
  ['ignored committed example', text => text.replace(/^!\*\.tfbackend\.example\n/m, '')],
  ['ignored provider locks', text => text + '\n*.hcl\n'],
]) test(`Git ignore tripwire rejects ${name}`, () => {
  const changed = change(ignores);
  assert.notEqual(changed, ignores);
  assert.notDeepEqual(ignoredPaths(changed), [...livePaths].sort());
});
