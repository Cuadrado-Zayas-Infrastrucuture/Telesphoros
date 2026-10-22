import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const workflow = readFileSync(new URL('../workflows/ci.yml', import.meta.url), 'utf8');
const dockerfile = readFileSync(new URL('../../infrastructure/docker/api.Dockerfile', import.meta.url), 'utf8');
const gitleaksPin = readFileSync(new URL('./gitleaks.version', import.meta.url), 'utf8');
const job = (text, name) => text.split(new RegExp(`^  ${name}:\\s*$`, 'm'))[1]?.split(/^  [a-z][a-z0-9-]*:\s*$/m)[0] ?? '';

function cacheProblems(text, image, pin = gitleaksPin) {
  const problems = [];
  const scan = job(text, 'secret-scan');
  if (!/cache: true\n\s+cache-dependency-path: \.github\/ci\/gitleaks\.version\n/.test(scan)) problems.push('Go cache tracks the pinned install configuration');
  const install = scan.match(/run: go install github\.com\/zricethezav\/gitleaks\/v8@(\S+)/)?.[1];
  if (!install || !/^v\d+\.\d+\.\d+$/.test(install) || pin.trim() !== install || scan.match(/- name: Install gitleaks (\S+)/)?.[1] !== install) problems.push('the version file, the install command and the step name name one gitleaks version');
  for (const name of ['Install gitleaks v8.30.1', 'Scan the full history']) {
    const step = scan.split(/^      - /m).find(s => s.startsWith('name: ' + name + '\n')) ?? '';
    if (!step || /^        (?:if|continue-on-error):/m.test(step)) problems.push('scan and install must run on a cache hit');
  }
  const browser = job(text, 'browser');
  if (!browser.includes('key: playwright-${{ runner.os }}-${{ runner.arch }}-${{ steps.playwright-version.outputs.version }}')) problems.push('browser cache follows installed Playwright and architecture');
  const build = job(text, 'image');
  if (!build.includes('cache-from: type=gha,scope=api-amd64-v1,timeout=2m') || !build.includes('cache-to: type=gha,scope=api-amd64-v1,mode=max,ignore-error=true,timeout=2m')) problems.push('bounded scoped image cache');
  const positions = ['COPY pnpm-lock.yaml pnpm-workspace.yaml ./', 'RUN pnpm fetch --frozen-lockfile', 'COPY . .', 'RUN pnpm install --frozen-lockfile --offline'].map(s => image.indexOf(s));
  if (positions.some(n => n < 0) || positions.some((n, i) => i > 0 && n <= positions[i - 1])) problems.push('source changes must not invalidate dependency fetch');
  return problems;
}

test('dependency caches preserve fresh installation/scanning and isolate Docker dependency inputs', () => {
  assert.deepEqual(cacheProblems(workflow, dockerfile), []);
  assert.deepEqual(lockfileCacheProblems(workflow), []);
  assert.match(workflow, /cancel-in-progress: \$\{\{ github.event_name == 'pull_request' \}\}/);
});

/** Every dependency cache is keyed by the file that decides its contents, so an unrelated edit cannot discard it and a changed lockfile cannot reuse it. */
function lockfileCacheProblems(text) {
  const problems = [];
  const pnpm = [...text.matchAll(/^( *)cache: pnpm\n(.*)\n/gm)];
  if (pnpm.length < 6) problems.push('expected every pnpm-using job to cache the store');
  for (const [, indent, next] of pnpm) if (next !== indent + 'cache-dependency-path: pnpm-lock.yaml') problems.push('a pnpm cache must be keyed by pnpm-lock.yaml');
  const pip = [...text.matchAll(/^( *)cache: pip\n(.*)\n/gm)];
  if (pip.length < 5) problems.push('expected every emulator job to cache pip downloads');
  for (const [, indent, next] of pip) if (next !== indent + 'cache-dependency-path: .github/ci/requirements.txt') problems.push('a pip cache must be keyed by the hashed requirements');
  if (/cache-dependency-path:.*\.github\/workflows\//.test(text)) problems.push('no cache may be keyed by a workflow file: every workflow edit would discard it');
  if (/key:.*(?:github\.sha|github\.run_id|github\.run_number)/.test(text)) problems.push('no cache key may contain a per-commit or per-run value');
  return problems;
}

test('lockfile-scoped caches: each pnpm and pip cache names its dependency file, none follows the workflow or the commit', () => {
  assert.deepEqual(lockfileCacheProblems(workflow), []);
  for (const [label, text] of Object.entries({
    'a pnpm cache keyed by the workflow': workflow.replace('cache-dependency-path: pnpm-lock.yaml', 'cache-dependency-path: .github/workflows/ci.yml'),
    'a pnpm cache with no explicit path': workflow.replace('          cache: pnpm\n          cache-dependency-path: pnpm-lock.yaml\n', '          cache: pnpm\n'),
    'a pip cache keyed by requirements.in': workflow.replace('cache-dependency-path: .github/ci/requirements.txt', 'cache-dependency-path: .github/ci/requirements.in'),
    'a browser key that follows the commit': workflow.replace('key: playwright-${{ runner.os }}', 'key: playwright-${{ github.sha }}-${{ runner.os }}'),
    'a Go cache keyed by the workflow again': workflow.replace('cache-dependency-path: .github/ci/gitleaks.version', 'cache-dependency-path: .github/workflows/ci.yml'),
  })) {
    assert.notEqual(text, workflow, label);
    assert.ok(lockfileCacheProblems(text).length + cacheProblems(text, dockerfile).length > 0, label + ' must be reported');
  }
  assert.ok(cacheProblems(workflow, dockerfile, 'v9.9.9\n').length > 0, 'a version file that disagrees with the install command must be reported');
  assert.ok(cacheProblems(workflow.replace('gitleaks/v8@v8.30.1', 'gitleaks/v8@v8.31.0'), dockerfile).length > 0, 'an install bump that leaves the version file behind must be reported');
});

test('cache controls reject stale browser keys, optional scanning and invalid layer order', () => {
  for (const [text, image] of [
    [workflow.replace('cache: true', 'cache: false'), dockerfile],
    [workflow.replace('steps.playwright-version.outputs.version', "hashFiles('pnpm-lock.yaml')"), dockerfile],
    [workflow.replace('- name: Scan the full history\n', '- name: Scan the full history\n        if: false\n'), dockerfile],
    [workflow.replace('- name: Install gitleaks v8.30.1\n', '- name: Install gitleaks v8.30.1\n        if: false\n'), dockerfile],
    [workflow.replace('timeout=2m', 'timeout=20m'), dockerfile],
    [workflow, dockerfile.replace('COPY . .\n', '').replace('RUN pnpm fetch --frozen-lockfile', 'COPY . .\nRUN pnpm fetch --frozen-lockfile')],
  ]) assert.ok(cacheProblems(text, image).length > 0);
});

test('the actual browser cache version command tracks package updates and refuses malformed metadata', () => {
  const browser = job(workflow, 'browser');
  const script = browser.match(/node <<'NODE'\n([\s\S]*?)^          NODE$/m)?.[1].replace(/^          /gm, '');
  assert.ok(script, 'execute the actual workflow command');
  const dir = mkdtempSync(join(tmpdir(), 'ci-browser-cache-'));
  try {
    const moduleDir = join(dir, 'node_modules/@playwright/test');
    mkdirSync(moduleDir, { recursive: true });
    for (const [i, version] of ['1.64.0', '1.65.0', '', '1.64', '1.64.0\nother=value'].entries()) {
      writeFileSync(join(moduleDir, 'package.json'), JSON.stringify({ version }));
      const output = join(dir, `output-${i}`);
      const result = spawnSync(process.execPath, ['-e', script], { cwd: dir, env: { ...process.env, GITHUB_OUTPUT: output }, encoding: 'utf8' });
      if (i < 2) {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(readFileSync(output, 'utf8'), `version=${version}\n`);
      } else {
        assert.notEqual(result.status, 0);
        assert.equal(existsSync(output), false, 'invalid metadata must not create a reusable cache key');
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
