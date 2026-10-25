const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { workspacePatterns, manifests, check } = require('./versions.cjs');

const root = resolve(__dirname, '../..');
const manifest = (path, json) => ({ path, json });

test('every external dependency has one range across the real workspace, and the scan found manifests to compare', () => {
  const read = manifests(root);
  assert.deepEqual(read.problems, []);
  const result = check(read.manifests);
  assert.deepEqual(result.problems, []);
  // A floor, so an empty or broken read cannot pass: the workspace shares many dependencies today.
  assert.ok(read.manifests.length > 3, `read ${read.manifests.length} manifests`);
  assert.ok(result.compared > 3, `compared ${result.compared} shared dependencies`);
});

test('refuses one dependency with two ranges in two packages', () => {
  const { problems } = check([
    manifest('package.json', { name: 'root' }),
    manifest('apps/a/package.json', { name: '@x/a', dependencies: { zod: '^4.6.7' } }),
    manifest('apps/b/package.json', { name: '@x/b', devDependencies: { zod: '^4.5.0' } }),
  ]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /"zod" has 2 ranges/);
  assert.match(problems[0], /apps\/a\/package\.json \(dependencies\)/);
  assert.match(problems[0], /apps\/b\/package\.json \(devDependencies\)/);
});

test('refuses two ranges for one dependency inside one package', () => {
  const { problems } = check([
    manifest('package.json', { name: 'root' }),
    manifest('apps/a/package.json', { name: '@x/a', dependencies: { pg: '^8.23.1' }, optionalDependencies: { pg: '^8.20.0' } }),
  ]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /"pg" has 2 ranges/);
});

test('refuses a workspace package referenced by a version range', () => {
  const { problems } = check([
    manifest('package.json', { name: 'root' }),
    manifest('packages/types/package.json', { name: '@x/types' }),
    manifest('apps/a/package.json', { name: '@x/a', dependencies: { '@x/types': '^1.0.0' } }),
  ]);
  assert.deepEqual(problems, ['apps/a/package.json: dependencies "@x/types" is "^1.0.0"; a workspace package is referenced as "workspace:*"']);
});

test('refuses the workspace protocol for a name no workspace package has', () => {
  const { problems } = check([
    manifest('package.json', { name: 'root' }),
    manifest('apps/a/package.json', { name: '@x/a', dependencies: { '@x/gone': 'workspace:*' } }),
  ]);
  assert.deepEqual(problems, ['apps/a/package.json: dependencies "@x/gone" is "workspace:*", but no workspace package has that name']);
});

test('refuses runtime dependencies on the workspace root', () => {
  const { problems } = check([manifest('package.json', { name: 'root', dependencies: { lodash: '^4.17.21' } })]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /the workspace root has dependencies \(lodash\)/);
});

test('consistent manifests pass and are counted (control)', () => {
  const result = check([
    manifest('package.json', { name: 'root', devDependencies: { typescript: '^6.0.3' } }),
    manifest('packages/types/package.json', { name: '@x/types', devDependencies: { typescript: '^6.0.3' } }),
    manifest('apps/a/package.json', { name: '@x/a', dependencies: { '@x/types': 'workspace:*', zod: '^4.6.7' }, devDependencies: { typescript: '^6.0.3' } }),
  ]);
  assert.deepEqual(result, { problems: [], compared: 1 });
});

test('reads the packages list and stops at the next key', () => {
  const yaml = ['packages:', '  - "apps/*"', "  - 'packages/*'", '  # a comment', '  - infrastructure/lambda/*  # trailing', '', 'onlyBuiltDependencies:', '  - esbuild'].join('\n');
  assert.deepEqual(workspacePatterns(yaml), ['apps/*', 'packages/*', 'infrastructure/lambda/*']);
  assert.deepEqual(workspacePatterns('onlyBuiltDependencies:\n  - esbuild\n'), []);
});

function fixtureWorkspace(yaml, packages) {
  const dir = mkdtempSync(join(tmpdir(), 'versions-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'root' }));
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), yaml);
  for (const name of packages) {
    mkdirSync(join(dir, 'apps', name), { recursive: true });
    writeFileSync(join(dir, 'apps', name, 'package.json'), JSON.stringify({ name: `@x/${name}` }));
  }
  return dir;
}

test('refuses a workspace pattern this check cannot read, so a package cannot drop out unnoticed', () => {
  const dir = fixtureWorkspace('packages:\n  - "apps/**"\n  - "!apps/skip"\n', ['a']);
  try {
    assert.deepEqual(manifests(dir).problems, [
      'pnpm-workspace.yaml: pattern "apps/**" is not of the form dir/*, the only form this check reads',
      'pnpm-workspace.yaml: pattern "!apps/skip" is not of the form dir/*, the only form this check reads',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('refuses a pattern that matches no package and a file with no packages list', () => {
  const empty = fixtureWorkspace('packages:\n  - "apps/*"\n  - "tools/*"\n', ['a']);
  const none = fixtureWorkspace('onlyBuiltDependencies:\n  - esbuild\n', []);
  try {
    assert.deepEqual(manifests(empty).problems, ['pnpm-workspace.yaml: pattern "tools/*" matches no package']);
    assert.deepEqual(manifests(none).problems, ['pnpm-workspace.yaml: no packages patterns were read']);
  } finally {
    rmSync(empty, { recursive: true, force: true });
    rmSync(none, { recursive: true, force: true });
  }
});

test('reads every package a matching pattern holds (control)', () => {
  const dir = fixtureWorkspace('packages:\n  - "apps/*"\n', ['b', 'a']);
  try {
    const read = manifests(dir);
    assert.deepEqual(read.problems, []);
    assert.deepEqual(read.manifests.map(({ path }) => path), ['package.json', 'apps/a/package.json', 'apps/b/package.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
